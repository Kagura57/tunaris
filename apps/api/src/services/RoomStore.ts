import { isTextAnswerCorrect } from "./FuzzyMatcher";
import { logEvent } from "../lib/logger";
import { applyScore } from "./ScoreCalculator";
import { hasAudioPreview, hasYouTubePlayback, isTrackPlayable } from "./PlaybackSupport";
import type { ClosedRound, GameState } from "./RoomManager";
import { RoomManager } from "./RoomManager";
import { trackCache } from "./TrackCache";
import type { MusicTrack } from "./music-types";

type RoundMode = "mcq" | "text";

type Player = {
  id: string;
  userId: string | null;
  displayName: string;
  score: number;
  streak: number;
  maxStreak: number;
  totalResponseMs: number;
  correctAnswers: number;
};

type RoomSession = {
  roomCode: string;
  createdAtMs: number;
  isPublic: boolean;
  manager: RoomManager;
  players: Map<string, Player>;
  nextPlayerNumber: number;
  trackPool: MusicTrack[];
  categoryQuery: string;
  totalRounds: number;
  roundModes: RoundMode[];
  roundChoices: Map<number, string[]>;
  latestReveal: {
    round: number;
    trackId: string;
    title: string;
    artist: string;
    provider: MusicTrack["provider"];
    mode: RoundMode;
    acceptedAnswer: string;
    previewUrl: string | null;
    sourceUrl: string | null;
    embedUrl: string | null;
    choices: string[] | null;
  } | null;
};

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEFAULT_ROUND_CONFIG = {
  countdownMs: 3_000,
  playingMs: 12_000,
  revealMs: 4_000,
  leaderboardMs: 3_000,
  baseScore: 1_000,
  maxRounds: 10,
} as const;

type RoundConfig = typeof DEFAULT_ROUND_CONFIG;

type RoomStoreDependencies = {
  now?: () => number;
  getTrackPool?: (categoryQuery: string, size: number) => Promise<MusicTrack[]>;
  config?: Partial<RoundConfig>;
};

function randomRoomCode(length = 6): string {
  let code = "";
  for (let index = 0; index < length; index += 1) {
    const randomIndex = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    const char = ROOM_CODE_ALPHABET[randomIndex];
    if (char) {
      code += char;
    }
  }
  return code;
}

function normalizeAnswer(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function averageResponseMs(player: Player) {
  if (player.correctAnswers <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return player.totalResponseMs / player.correctAnswers;
}

function modeForRound(round: number): RoundMode {
  return round % 2 === 1 ? "mcq" : "text";
}

function asChoiceLabel(track: MusicTrack) {
  return `${track.title} - ${track.artist}`;
}

function embedUrlForTrack(track: Pick<MusicTrack, "provider" | "id">) {
  if (track.provider === "spotify") {
    return `https://open.spotify.com/embed/track/${track.id}?utm_source=tunaris`;
  }
  if (track.provider === "youtube" || track.provider === "ytmusic") {
    return `https://www.youtube.com/embed/${track.id}?autoplay=1&controls=0&disablekb=1&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0`;
  }
  if (track.provider === "deezer") {
    return `https://widget.deezer.com/widget/dark/track/${track.id}`;
  }
  return null;
}

function randomShuffle<T>(values: T[]) {
  const copied = [...values];
  for (let index = copied.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = copied[index];
    copied[index] = copied[swapIndex] as T;
    copied[swapIndex] = current as T;
  }
  return copied;
}

export class RoomStore {
  private readonly rooms = new Map<string, RoomSession>();
  private readonly now: () => number;
  private readonly getTrackPool: (categoryQuery: string, size: number) => Promise<MusicTrack[]>;
  private readonly config: RoundConfig;

  constructor(dependencies: RoomStoreDependencies = {}) {
    this.now = dependencies.now ?? (() => Date.now());
    this.getTrackPool = dependencies.getTrackPool ?? ((categoryQuery, size) =>
      trackCache.getOrBuild(categoryQuery, size));
    this.config = {
      ...DEFAULT_ROUND_CONFIG,
      ...(dependencies.config ?? {}),
    };
  }

  private ranking(session: RoomSession) {
    return [...session.players.values()]
      .sort((a, b) => {
        const byScore = b.score - a.score;
        if (byScore !== 0) return byScore;

        const byStreak = b.maxStreak - a.maxStreak;
        if (byStreak !== 0) return byStreak;

        const avgA = averageResponseMs(a);
        const avgB = averageResponseMs(b);
        const avgAIsFinite = Number.isFinite(avgA);
        const avgBIsFinite = Number.isFinite(avgB);

        if (avgAIsFinite && avgBIsFinite) {
          return avgA - avgB;
        }

        if (avgAIsFinite) return -1;
        if (avgBIsFinite) return 1;
        return 0;
      })
      .map((player, index) => ({
        rank: index + 1,
        playerId: player.id,
        userId: player.userId,
        displayName: player.displayName,
        score: player.score,
        maxStreak: player.maxStreak,
        averageResponseMs: Number.isFinite(averageResponseMs(player))
          ? Math.round(averageResponseMs(player))
          : null,
      }));
  }

  private buildRoundChoices(session: RoomSession, round: number) {
    const existing = session.roundChoices.get(round);
    if (existing) return existing;

    const track = session.trackPool[round - 1];
    if (!track) return [];

    const correct = asChoiceLabel(track);
    const distractors = session.trackPool
      .filter((candidate) => candidate.id !== track.id)
      .map(asChoiceLabel)
      .filter((value, index, source) => source.indexOf(value) === index)
      .slice(0, 8);

    const randomizedDistractors = randomShuffle(distractors);
    const options = randomShuffle([correct, ...randomizedDistractors.slice(0, 3)]);
    while (options.length < 4) {
      options.push(correct);
    }

    session.roundChoices.set(round, options);
    return options;
  }

  private isAnswerCorrect(roundMode: RoundMode, answer: string, track: MusicTrack | null) {
    if (!track) return false;

    if (roundMode === "mcq") {
      const expected = normalizeAnswer(asChoiceLabel(track));
      return normalizeAnswer(answer) === expected;
    }

    return (
      isTextAnswerCorrect(answer, track.title) ||
      isTextAnswerCorrect(answer, track.artist) ||
      isTextAnswerCorrect(answer, `${track.title} ${track.artist}`) ||
      isTextAnswerCorrect(answer, asChoiceLabel(track))
    );
  }

  private progressSession(session: RoomSession, nowMs: number) {
    const tick = session.manager.tick({
      nowMs,
      roundMs: this.config.playingMs,
      revealMs: this.config.revealMs,
      leaderboardMs: this.config.leaderboardMs,
    });

    if (tick.closedRounds.length === 0) return;

    for (const closedRound of tick.closedRounds) {
      this.applyRoundResults(session, closedRound);
    }
  }

  private applyRoundResults(session: RoomSession, round: ClosedRound) {
    const track = session.trackPool[round.round - 1] ?? null;
    const roundMode = session.roundModes[round.round - 1] ?? "text";
    const roundChoices =
      roundMode === "mcq" ? this.buildRoundChoices(session, round.round) : null;

    for (const player of session.players.values()) {
      const submitted = round.answers.get(player.id);
      const isCorrect = submitted ? this.isAnswerCorrect(roundMode, submitted.value, track) : false;
      const responseMs =
        submitted && isCorrect ? Math.max(0, submitted.submittedAtMs - round.startedAtMs) : 0;
      const scoring = applyScore({
        isCorrect,
        responseMs,
        streak: player.streak,
        baseScore: this.config.baseScore,
      });

      player.score += scoring.earned;
      player.streak = scoring.nextStreak;
      player.maxStreak = Math.max(player.maxStreak, player.streak);

      if (isCorrect) {
        player.correctAnswers += 1;
        player.totalResponseMs += responseMs;
      }
    }

    session.latestReveal = track
      ? {
          round: round.round,
          trackId: track.id,
          title: track.title,
          artist: track.artist,
          provider: track.provider,
          mode: roundMode,
          acceptedAnswer: asChoiceLabel(track),
          previewUrl: track.previewUrl,
          sourceUrl: track.sourceUrl,
          embedUrl: embedUrlForTrack(track),
          choices: roundChoices,
        }
      : null;
  }

  createRoom(options: { isPublic?: boolean; categoryQuery?: string } = {}) {
    const nowMs = this.now();
    let roomCode = randomRoomCode();
    while (this.rooms.has(roomCode)) {
      roomCode = randomRoomCode();
    }

    const session: RoomSession = {
      roomCode,
      createdAtMs: nowMs,
      isPublic: options.isPublic ?? true,
      manager: new RoomManager(roomCode),
      players: new Map(),
      nextPlayerNumber: 1,
      trackPool: [],
      categoryQuery: options.categoryQuery?.trim() || "spotify:popular",
      totalRounds: 0,
      roundModes: [],
      roundChoices: new Map(),
      latestReveal: null,
    };

    this.rooms.set(roomCode, session);
    return { roomCode };
  }

  joinRoom(roomCode: string, displayName: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };
    if (session.manager.state() !== "waiting") {
      return { status: "room_not_joinable" as const };
    }

    const playerId = `p${session.nextPlayerNumber}`;
    session.nextPlayerNumber += 1;

    const player: Player = {
      id: playerId,
      userId: null,
      displayName,
      score: 0,
      streak: 0,
      maxStreak: 0,
      totalResponseMs: 0,
      correctAnswers: 0,
    };

    session.players.set(playerId, player);

    return {
      status: "ok" as const,
      value: {
        ok: true as const,
        playerId,
        playerCount: session.players.size,
      },
    };
  }

  joinRoomAsUser(roomCode: string, displayName: string, userId: string | null) {
    const joined = this.joinRoom(roomCode, displayName);
    if (joined.status !== "ok") return joined;

    const session = this.rooms.get(roomCode);
    const player = session?.players.get(joined.value.playerId);
    if (player) {
      player.userId = userId;
    }

    return joined.value;
  }

  async startGame(roomCode: string, categoryQuery?: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return null;

    if (session.manager.state() === "waiting") {
      const poolSize = Math.max(1, this.config.maxRounds);
      const resolvedQuery = categoryQuery?.trim() || session.categoryQuery || "spotify:popular";
      session.categoryQuery = resolvedQuery;
      const rawTrackPool = await this.getTrackPool(resolvedQuery, Math.min(50, poolSize * 5));
      const playablePool = rawTrackPool.filter((track) => isTrackPlayable(track));
      session.trackPool = randomShuffle(playablePool).slice(0, poolSize);
      session.totalRounds = Math.min(session.trackPool.length, this.config.maxRounds);
      session.latestReveal = null;

      if (session.totalRounds <= 0) {
        logEvent("warn", "room_start_no_tracks", {
          roomCode,
          categoryQuery: resolvedQuery,
          requestedPoolSize: poolSize,
          players: session.players.size,
        });
        return {
          ok: false as const,
          error: "NO_TRACKS_FOUND" as const,
        };
      }

      session.roundModes = Array.from({ length: session.totalRounds }, (_, index) =>
        modeForRound(index + 1),
      );
      session.roundChoices.clear();

      for (let round = 1; round <= session.totalRounds; round += 1) {
        if (session.roundModes[round - 1] === "mcq") {
          this.buildRoundChoices(session, round);
        }
      }

      for (const player of session.players.values()) {
        player.score = 0;
        player.streak = 0;
        player.maxStreak = 0;
        player.totalResponseMs = 0;
        player.correctAnswers = 0;
      }

      const tracksWithPreview = session.trackPool.filter((track) => hasAudioPreview(track)).length;
      const tracksWithYouTube = session.trackPool.filter((track) => hasYouTubePlayback(track)).length;
      logEvent("info", "room_start_audio_preview_coverage", {
        roomCode,
        categoryQuery: resolvedQuery,
        poolSize: session.trackPool.length,
        rawPoolSize: rawTrackPool.length,
        previewCount: tracksWithPreview,
        youtubePlaybackCount: tracksWithYouTube,
        players: session.players.size,
      });

      session.manager.startGame({
        nowMs: this.now(),
        countdownMs: this.config.countdownMs,
        totalRounds: session.totalRounds,
      });
    }

    this.progressSession(session, this.now());

    return {
      ok: true as const,
      state: session.manager.state(),
      poolSize: session.trackPool.length,
      categoryQuery: session.categoryQuery,
      totalRounds: session.totalRounds,
      deadlineMs: session.manager.deadlineMs(),
    };
  }

  submitAnswer(roomCode: string, playerId: string, answer: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };

    const nowMs = this.now();
    this.progressSession(session, nowMs);

    const player = session.players.get(playerId);
    if (!player) return { status: "player_not_found" as const };

    const result = session.manager.submitAnswer(playerId, answer, nowMs);
    return { status: "ok" as const, accepted: result.accepted };
  }

  roomState(roomCode: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return null;

    this.progressSession(session, this.now());

    const state = session.manager.state() as GameState;
    const currentRound = session.manager.round();
    const activeTrack = currentRound > 0 ? (session.trackPool[currentRound - 1] ?? null) : null;
    const currentMode = currentRound > 0 ? (session.roundModes[currentRound - 1] ?? null) : null;
    const choices =
      state === "playing" && currentMode === "mcq"
        ? this.buildRoundChoices(session, currentRound)
        : null;
    const leaderboard = this.ranking(session).slice(0, 10);
    const revealMedia =
      state === "reveal" || state === "leaderboard" || state === "results"
        ? session.latestReveal
        : null;
    const media =
      state === "playing" && activeTrack
        ? {
            provider: activeTrack.provider,
            trackId: activeTrack.id,
            sourceUrl: activeTrack.sourceUrl,
            embedUrl: embedUrlForTrack(activeTrack),
          }
        : revealMedia
          ? {
              provider: revealMedia.provider,
              trackId: revealMedia.trackId,
              sourceUrl: revealMedia.sourceUrl,
              embedUrl: revealMedia.embedUrl,
            }
          : null;

    return {
      roomCode: session.roomCode,
      state,
      round: currentRound,
      mode: currentMode,
      choices,
      serverNowMs: this.now(),
      playerCount: session.players.size,
      poolSize: session.trackPool.length,
      categoryQuery: session.categoryQuery,
      totalRounds: session.totalRounds,
      deadlineMs: session.manager.deadlineMs(),
      previewUrl:
        state === "playing"
          ? activeTrack?.previewUrl ?? null
          : revealMedia?.previewUrl ?? null,
      media,
      reveal: revealMedia,
      leaderboard,
    };
  }

  roomResults(roomCode: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return null;

    this.progressSession(session, this.now());

    return {
      roomCode: session.roomCode,
      categoryQuery: session.categoryQuery,
      state: session.manager.state() as GameState,
      round: session.manager.round(),
      ranking: this.ranking(session),
    };
  }

  diagnostics() {
    let totalPlayers = 0;
    const stateCounts: Record<string, number> = {};

    for (const session of this.rooms.values()) {
      totalPlayers += session.players.size;
      const state = session.manager.state();
      stateCounts[state] = (stateCounts[state] ?? 0) + 1;
    }

    return {
      roomCount: this.rooms.size,
      totalPlayers,
      stateCounts,
      config: this.config,
    };
  }

  publicRooms() {
    const nowMs = this.now();
    const visibleStates = new Set<GameState>([
      "waiting",
      "countdown",
      "playing",
      "reveal",
      "leaderboard",
    ]);

    const rooms: Array<{
      roomCode: string;
      isPublic: boolean;
      state: GameState;
      round: number;
      totalRounds: number;
      playerCount: number;
      categoryQuery: string;
      createdAtMs: number;
      canJoin: boolean;
      deadlineMs: number | null;
      serverNowMs: number;
    }> = [];

    for (const session of this.rooms.values()) {
      if (!session.isPublic) continue;
      this.progressSession(session, nowMs);
      const state = session.manager.state() as GameState;
      if (!visibleStates.has(state)) continue;

      rooms.push({
        roomCode: session.roomCode,
        isPublic: session.isPublic,
        state,
        round: session.manager.round(),
        totalRounds: session.totalRounds,
        playerCount: session.players.size,
        categoryQuery: session.categoryQuery,
        createdAtMs: session.createdAtMs,
        canJoin: state === "waiting",
        deadlineMs: session.manager.deadlineMs(),
        serverNowMs: nowMs,
      });
    }

    return rooms.sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 50);
  }
}

export const roomStore = new RoomStore();
