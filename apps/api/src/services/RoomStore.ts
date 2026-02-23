import { isTextAnswerCorrect } from "./FuzzyMatcher";
import { logEvent } from "../lib/logger";
import { providerMetricsSnapshot } from "../lib/provider-metrics";
import { applyScore } from "./ScoreCalculator";
import { hasAudioPreview, hasYouTubePlayback, isTrackPlayable } from "./PlaybackSupport";
import type { ClosedRound, GameState } from "./RoomManager";
import { RoomManager } from "./RoomManager";
import { trackCache } from "./TrackCache";
import type { MusicTrack } from "./music-types";
import { SPOTIFY_RATE_LIMITED_ERROR, spotifyPlaylistRateLimitRetryAfterMs } from "../routes/music/spotify";
import { fetchUserLikedTracksForProviders } from "./UserMusicLibrary";

type RoundMode = "mcq" | "text";
type RoomSourceMode = "public_playlist" | "players_liked";
type LibraryProvider = "spotify" | "deezer";
type ProviderLinkStatus = "linked" | "not_linked" | "expired";
type PoolBuildStatus = "idle" | "building" | "ready" | "failed";

type PlayerLibraryState = {
  includeInPool: Record<LibraryProvider, boolean>;
  linkedProviders: Record<LibraryProvider, ProviderLinkStatus>;
  estimatedTrackCount: Record<LibraryProvider, number | null>;
  syncStatus: "idle" | "syncing" | "ready" | "error";
  lastError: string | null;
};

type Player = {
  id: string;
  userId: string | null;
  displayName: string;
  joinedAtMs: number;
  isReady: boolean;
  score: number;
  streak: number;
  maxStreak: number;
  totalResponseMs: number;
  correctAnswers: number;
  library: PlayerLibraryState;
};

type RoomSession = {
  roomCode: string;
  createdAtMs: number;
  isPublic: boolean;
  manager: RoomManager;
  players: Map<string, Player>;
  hostPlayerId: string | null;
  nextPlayerNumber: number;
  trackPool: MusicTrack[];
  distractorTrackPool: MusicTrack[];
  sourceMode: RoomSourceMode;
  publicPlaylistSelection: {
    provider: "deezer";
    id: string;
    name: string;
    trackCount: number | null;
    sourceQuery: string;
    selectedByPlayerId: string;
  } | null;
  playersLikedRules: {
    minContributors: number;
    minTotalTracks: number;
  };
  playersLikedPool: MusicTrack[];
  poolBuild: {
    status: PoolBuildStatus;
    contributorsCount: number;
    playableTracksCount: number;
    lastBuiltAtMs: number | null;
    errorCode: string | null;
  };
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

const TRACK_POOL_TARGET_MULTIPLIER = 5;
const TRACK_POOL_MIN_CANDIDATES = 24;
const TRACK_POOL_MAX_CANDIDATES = 100;

type RoundConfig = typeof DEFAULT_ROUND_CONFIG;

type RoomStoreDependencies = {
  now?: () => number;
  getTrackPool?: (categoryQuery: string, size: number) => Promise<MusicTrack[]>;
  getPlayerLikedTracks?: (input: {
    userId: string;
    providers: LibraryProvider[];
    size: number;
  }) => Promise<MusicTrack[]>;
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

const TRACK_PROMOTION_PATTERNS = [
  /\b(this\s+app|download\s+app|free\s+music\s+alternative|best\s+free\s+music)\b/i,
  /\bspotify\b.*\b(app|alternative|free)\b/i,
  /\bdeezer\s*-\s*deezer\b/i,
  /\bdeezer\s*session\b/i,
  /\bheartify\b/i,
];

function looksLikePromotionalTrack(track: Pick<MusicTrack, "title" | "artist">) {
  const text = `${track.title} ${track.artist}`
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return TRACK_PROMOTION_PATTERNS.some((pattern) => pattern.test(text));
}

function embedUrlForTrack(track: Pick<MusicTrack, "provider" | "id">) {
  if (track.provider === "spotify") {
    return `https://open.spotify.com/embed/track/${track.id}?utm_source=tunaris`;
  }
  if (track.provider === "youtube") {
    return `https://www.youtube.com/embed/${track.id}?autoplay=1&controls=0&disablekb=1&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0&fs=0&enablejsapi=1`;
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutErrorCode: string,
) {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutErrorCode));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function trackSignature(track: Pick<MusicTrack, "provider" | "id" | "title" | "artist">) {
  return `${track.provider}:${track.id}:${track.title.toLowerCase()}:${track.artist.toLowerCase()}`;
}

function defaultPlayerLibraryState(): PlayerLibraryState {
  return {
    includeInPool: {
      spotify: false,
      deezer: false,
    },
    linkedProviders: {
      spotify: "not_linked",
      deezer: "not_linked",
    },
    estimatedTrackCount: {
      spotify: null,
      deezer: null,
    },
    syncStatus: "idle",
    lastError: null,
  };
}

function normalizeProviderLinkStatus(value: ProviderLinkStatus | null | undefined): ProviderLinkStatus {
  if (value === "linked" || value === "expired") return value;
  return "not_linked";
}

export class RoomStore {
  private readonly rooms = new Map<string, RoomSession>();
  private readonly roomPreloadJobs = new Map<string, Promise<void>>();
  private readonly roomLikedPoolJobs = new Map<string, Promise<void>>();
  private readonly roomLikedPoolRebuildRequested = new Set<string>();
  private readonly now: () => number;
  private readonly getTrackPool: (categoryQuery: string, size: number) => Promise<MusicTrack[]>;
  private readonly getPlayerLikedTracks: (input: {
    userId: string;
    providers: LibraryProvider[];
    size: number;
  }) => Promise<MusicTrack[]>;
  private readonly config: RoundConfig;

  constructor(dependencies: RoomStoreDependencies = {}) {
    this.now = dependencies.now ?? (() => Date.now());
    this.getTrackPool = dependencies.getTrackPool ?? ((categoryQuery, size) =>
      trackCache.getOrBuild(categoryQuery, size));
    this.getPlayerLikedTracks = dependencies.getPlayerLikedTracks ?? fetchUserLikedTracksForProviders;
    this.config = {
      ...DEFAULT_ROUND_CONFIG,
      ...(dependencies.config ?? {}),
    };
  }

  private sortedPlayers(session: RoomSession) {
    return [...session.players.values()].sort((left, right) => left.joinedAtMs - right.joinedAtMs);
  }

  private ensureHost(session: RoomSession) {
    if (session.hostPlayerId && session.players.has(session.hostPlayerId)) {
      return session.hostPlayerId;
    }
    const nextHost = this.sortedPlayers(session)[0]?.id ?? null;
    session.hostPlayerId = nextHost;
    return nextHost;
  }

  private resetReadyStates(session: RoomSession) {
    for (const player of session.players.values()) {
      player.isReady = false;
    }
  }

  private sourceQueryForSession(session: RoomSession) {
    if (session.sourceMode === "public_playlist") {
      return session.publicPlaylistSelection?.sourceQuery?.trim() || session.categoryQuery.trim();
    }
    return "players:liked";
  }

  private playersLikedContributors(session: RoomSession) {
    return [...session.players.values()].filter((player) => {
      if (!player.userId) return false;
      const spotifyIncluded =
        player.library.includeInPool.spotify &&
        player.library.linkedProviders.spotify === "linked";
      const deezerIncluded =
        player.library.includeInPool.deezer &&
        player.library.linkedProviders.deezer === "linked";
      return spotifyIncluded || deezerIncluded;
    });
  }

  private canStartWaitingSession(session: RoomSession) {
    if (session.manager.state() !== "waiting") return false;
    const players = this.sortedPlayers(session);
    const readyCount = players.filter((player) => player.isReady).length;
    const allReady = players.length > 0 && readyCount === players.length;
    if (!allReady) return false;

    if (session.sourceMode === "public_playlist") {
      return this.sourceQueryForSession(session).length > 0;
    }

    if (session.poolBuild.status !== "ready") return false;
    if (session.poolBuild.playableTracksCount < session.playersLikedRules.minTotalTracks) return false;
    const contributors = this.playersLikedContributors(session);
    return contributors.length >= session.playersLikedRules.minContributors;
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

  private targetCandidatePoolSize(requestedRounds: number) {
    const safeRounds = Math.max(1, requestedRounds);
    return Math.min(
      TRACK_POOL_MAX_CANDIDATES,
      Math.max(
        safeRounds + 3,
        safeRounds * TRACK_POOL_TARGET_MULTIPLIER,
        TRACK_POOL_MIN_CANDIDATES,
      ),
    );
  }

  private splitAnswerAndDistractorPools(tracks: MusicTrack[], requestedRounds: number) {
    const safeRounds = Math.max(1, requestedRounds);
    const shuffled = randomShuffle(tracks);
    const answers = shuffled.slice(0, safeRounds);
    const distractors = shuffled.slice(safeRounds);
    return {
      tracks: answers,
      distractorTracks: distractors,
      candidateCount: shuffled.length,
    };
  }

  private buildRoundChoices(session: RoomSession, round: number) {
    const existing = session.roundChoices.get(round);
    if (existing) return existing;

    const track = session.trackPool[round - 1];
    if (!track) return [];

    const correct = asChoiceLabel(track);
    const distractors = randomShuffle(
      session.distractorTrackPool
        .map(asChoiceLabel)
        .filter((value) => value !== correct)
    );

    const uniqueOptions = [correct];
    const seen = new Set(uniqueOptions);
    for (const distractor of distractors) {
      if (seen.has(distractor)) continue;
      uniqueOptions.push(distractor);
      seen.add(distractor);
      if (uniqueOptions.length >= 4) break;
    }

    let syntheticIndex = 1;
    while (uniqueOptions.length < 4) {
      const syntheticChoice = `Choix alternatif ${round}-${syntheticIndex}`;
      syntheticIndex += 1;
      if (seen.has(syntheticChoice)) continue;
      uniqueOptions.push(syntheticChoice);
      seen.add(syntheticChoice);
    }

    const options = randomShuffle(uniqueOptions);
    session.roundChoices.set(round, options);
    return options;
  }

  private async buildStartTrackPool(categoryQuery: string, requestedRounds: number) {
    const safeRounds = Math.max(1, requestedRounds);
    const targetCandidateSize = this.targetCandidatePoolSize(safeRounds);
    const collected: MusicTrack[] = [];
    const seen = new Set<string>();
    const maxAttempts = 6;
    const maxFetchSize = TRACK_POOL_MAX_CANDIDATES;
    let requestSize = Math.min(
      maxFetchSize,
      Math.max(safeRounds * 2, safeRounds + 3, Math.min(targetCandidateSize, 36)),
    );
    let rawTotal = 0;
    let playableTotal = 0;
    let cleanTotal = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const rawTrackPool = await withTimeout(
        this.getTrackPool(categoryQuery, requestSize),
        15_000,
        "TRACK_POOL_LOAD_TIMEOUT",
      );
      rawTotal += rawTrackPool.length;

      const playablePool = rawTrackPool.filter((track) => isTrackPlayable(track));
      playableTotal += playablePool.length;
      const cleanPool = playablePool.filter((track) => !looksLikePromotionalTrack(track));
      cleanTotal += cleanPool.length;

      let added = 0;
      for (const track of randomShuffle(cleanPool)) {
        const signature = trackSignature(track);
        if (seen.has(signature)) continue;
        seen.add(signature);
        collected.push(track);
        added += 1;
        if (collected.length >= targetCandidateSize) break;
      }

      logEvent("info", "room_start_trackpool_attempt", {
        categoryQuery,
        attempt,
        requestSize,
        rawCount: rawTrackPool.length,
        playableCount: playablePool.length,
        cleanCount: cleanPool.length,
        addedCount: added,
        accumulated: collected.length,
        requestedRounds: safeRounds,
        targetCandidateSize,
      });

      if (collected.length >= targetCandidateSize) break;
      if (rawTrackPool.length <= 0 || cleanPool.length <= 0) {
        break;
      }

      const nextSize = Math.min(
        maxFetchSize,
        Math.max(requestSize + safeRounds, Math.ceil(requestSize * 1.5)),
      );
      const reachedCeiling = requestSize >= maxFetchSize;
      const sourceLooksExhausted = rawTrackPool.length < requestSize;
      if (added <= 0 && sourceLooksExhausted) break;
      if (added <= 0 && reachedCeiling) break;
      requestSize = nextSize;
    }

    const split = this.splitAnswerAndDistractorPools(collected, safeRounds);
    return {
      tracks: split.tracks,
      distractorTracks: split.distractorTracks,
      candidateCount: split.candidateCount,
      rawTotal,
      playableTotal,
      cleanTotal,
    };
  }

  private stopPlayersLikedPoolJob(roomCode: string) {
    this.roomLikedPoolJobs.delete(roomCode);
  }

  private async buildPlayersLikedTrackPool(session: RoomSession, requestedRounds: number) {
    const safeRounds = Math.max(1, requestedRounds);
    const targetCandidateSize = this.targetCandidatePoolSize(safeRounds);
    const contributors = this.playersLikedContributors(session);
    const mergedTracks: MusicTrack[] = [];
    const seen = new Set<string>();
    let fetchedTotal = 0;

    for (const contributor of contributors) {
      const providers: LibraryProvider[] = [];
      if (contributor.library.includeInPool.spotify && contributor.library.linkedProviders.spotify === "linked") {
        providers.push("spotify");
      }
      if (contributor.library.includeInPool.deezer && contributor.library.linkedProviders.deezer === "linked") {
        providers.push("deezer");
      }
      if (!contributor.userId || providers.length <= 0) continue;

      const fetched = await withTimeout(
        this.getPlayerLikedTracks({
          userId: contributor.userId,
          providers,
          size: Math.max(targetCandidateSize, 20),
        }),
        20_000,
        "PLAYERS_LIBRARY_TIMEOUT",
      );
      console.log("[players-liked-debug] contributor_fetch", {
        roomCode: session.roomCode,
        contributorPlayerId: contributor.id,
        contributorUserId: contributor.userId,
        providers,
        fetchedCount: fetched.length,
      });
      fetchedTotal += fetched.length;

      for (const track of fetched) {
        if (!isTrackPlayable(track)) continue;
        if (looksLikePromotionalTrack(track)) continue;
        const key = trackSignature(track);
        if (seen.has(key)) continue;
        seen.add(key);
        mergedTracks.push(track);
      }
    }

    const split = this.splitAnswerAndDistractorPools(mergedTracks, safeRounds);
    console.log("[players-liked-debug] build_pool_done", {
      roomCode: session.roomCode,
      requestedRounds: safeRounds,
      targetCandidateSize,
      contributorsCount: contributors.length,
      fetchedTotal,
      mergedTracksCount: mergedTracks.length,
      answersCount: split.tracks.length,
      distractorCount: split.distractorTracks.length,
      candidateCount: split.candidateCount,
    });
    return {
      tracks: split.tracks,
      distractorTracks: split.distractorTracks,
      candidateCount: split.candidateCount,
      fetchedTotal,
      playableTotal: mergedTracks.length,
      cleanTotal: mergedTracks.length,
      contributorsCount: contributors.length,
    };
  }

  private startPlayersLikedPoolBuild(session: RoomSession) {
    if (session.sourceMode !== "players_liked") return;
    if (this.roomLikedPoolJobs.has(session.roomCode)) {
      this.roomLikedPoolRebuildRequested.add(session.roomCode);
      return;
    }

    const roomCode = session.roomCode;
    const desiredSize = Math.max(session.playersLikedRules.minTotalTracks, this.config.maxRounds);
    this.roomLikedPoolRebuildRequested.delete(roomCode);
    session.poolBuild.status = "building";
    session.poolBuild.errorCode = null;
    const buildJob = (async () => {
      try {
        const built = await this.buildPlayersLikedTrackPool(session, desiredSize);
        if (session.sourceMode !== "players_liked") {
          return;
        }
        session.playersLikedPool = [...built.tracks, ...built.distractorTracks];
        session.poolBuild.status = built.tracks.length > 0 ? "ready" : "failed";
        session.poolBuild.contributorsCount = built.contributorsCount;
        session.poolBuild.playableTracksCount = built.candidateCount;
        session.poolBuild.lastBuiltAtMs = this.now();
        session.poolBuild.errorCode = built.tracks.length > 0 ? null : "NO_TRACKS_FOUND";
      } catch (error) {
        session.playersLikedPool = [];
        session.poolBuild.status = "failed";
        session.poolBuild.contributorsCount = this.playersLikedContributors(session).length;
        session.poolBuild.playableTracksCount = 0;
        session.poolBuild.lastBuiltAtMs = this.now();
        session.poolBuild.errorCode = error instanceof Error ? error.message : "UNKNOWN_ERROR";
      } finally {
        this.stopPlayersLikedPoolJob(roomCode);
        if (this.roomLikedPoolRebuildRequested.has(roomCode)) {
          this.roomLikedPoolRebuildRequested.delete(roomCode);
          const latest = this.rooms.get(roomCode);
          if (latest && latest.sourceMode === "players_liked" && latest.manager.state() === "waiting") {
            this.startPlayersLikedPoolBuild(latest);
          }
        }
      }
    })();

    this.roomLikedPoolJobs.set(roomCode, buildJob);
  }

  private stopPreloadJob(roomCode: string) {
    this.roomPreloadJobs.delete(roomCode);
  }

  private refreshRoundPlan(session: RoomSession) {
    const plannedRounds = Math.min(session.trackPool.length, this.config.maxRounds);
    session.totalRounds = plannedRounds;
    if (plannedRounds <= 0) {
      session.roundModes = [];
      return;
    }

    for (let round = session.roundModes.length + 1; round <= plannedRounds; round += 1) {
      session.roundModes.push(modeForRound(round));
    }
    if (session.roundModes.length > plannedRounds) {
      session.roundModes = session.roundModes.slice(0, plannedRounds);
    }

    if (session.manager.state() !== "waiting" && session.manager.state() !== "results") {
      session.manager.setTotalRounds(plannedRounds);
    }
  }

  private mergeResolvedTracks(session: RoomSession, tracks: MusicTrack[], targetPoolSize: number) {
    const existing = new Set(session.trackPool.map((track) => trackSignature(track)));
    for (const track of tracks) {
      const signature = trackSignature(track);
      if (existing.has(signature)) continue;
      session.trackPool.push(track);
      existing.add(signature);
      if (session.trackPool.length >= targetPoolSize) break;
    }
  }

  private startTrackPreload(session: RoomSession, categoryQuery: string, targetRounds: number) {
    if (this.roomPreloadJobs.has(session.roomCode)) return;

    const roomCode = session.roomCode;
    const preloadPromise = (async () => {
      const desiredPoolSize = Math.min(40, Math.max(targetRounds * 2, targetRounds));
      const rawTrackPool = await this.getTrackPool(categoryQuery, desiredPoolSize);
      const playablePool = rawTrackPool.filter((track) => isTrackPlayable(track));
      const cleanPool = playablePool.filter((track) => !looksLikePromotionalTrack(track));
      const shuffled = randomShuffle(cleanPool);

      const beforeCount = session.trackPool.length;
      this.mergeResolvedTracks(session, shuffled, desiredPoolSize);
      this.refreshRoundPlan(session);

      const added = Math.max(0, session.trackPool.length - beforeCount);
      if (added > 0) {
        logEvent("info", "room_preload_tracks_completed", {
          roomCode,
          categoryQuery,
          desiredPoolSize,
          targetRounds,
          added,
          totalResolved: session.trackPool.length,
          totalRounds: session.totalRounds,
        });
      } else {
        logEvent("warn", "room_preload_tracks_no_new_tracks", {
          roomCode,
          categoryQuery,
          desiredPoolSize,
          targetRounds,
          totalResolved: session.trackPool.length,
          totalRounds: session.totalRounds,
        });
      }
    })()
      .catch((error) => {
        logEvent("warn", "room_preload_tracks_failed", {
          roomCode,
          categoryQuery,
          desiredPoolSize: Math.min(40, Math.max(targetRounds * 2, targetRounds)),
          targetRounds,
          error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
        });
      })
      .finally(() => {
        this.stopPreloadJob(roomCode);
      });

    this.roomPreloadJobs.set(roomCode, preloadPromise);
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

  private isSpotifyRateLimitedRecently() {
    const spotify = providerMetricsSnapshot().spotify;
    if (!spotify || spotify.lastStatus !== 429) return false;
    const lastSeenAtMs = Date.parse(spotify.lastSeenAt);
    if (!Number.isFinite(lastSeenAtMs)) return true;
    return Date.now() - lastSeenAtMs <= 30_000;
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
      hostPlayerId: null,
      nextPlayerNumber: 1,
      trackPool: [],
      distractorTrackPool: [],
      sourceMode: "public_playlist",
      publicPlaylistSelection: null,
      playersLikedRules: {
        minContributors: 1,
        minTotalTracks: Math.max(1, this.config.maxRounds),
      },
      playersLikedPool: [],
      poolBuild: {
        status: "idle",
        contributorsCount: 0,
        playableTracksCount: 0,
        lastBuiltAtMs: null,
        errorCode: null,
      },
      categoryQuery: options.categoryQuery?.trim() ?? "",
      totalRounds: 0,
      roundModes: [],
      roundChoices: new Map(),
      latestReveal: null,
    };
    if (session.categoryQuery.toLowerCase().startsWith("deezer:playlist:")) {
      session.publicPlaylistSelection = {
        provider: "deezer",
        id: session.categoryQuery.slice("deezer:playlist:".length),
        name: session.categoryQuery,
        trackCount: null,
        sourceQuery: session.categoryQuery,
        selectedByPlayerId: "system",
      };
    }

    this.rooms.set(roomCode, session);
    return { roomCode };
  }

  joinRoom(roomCode: string, displayName: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };
    if (session.manager.state() === "results") {
      return { status: "room_not_joinable" as const };
    }

    const playerId = `p${session.nextPlayerNumber}`;
    session.nextPlayerNumber += 1;

    const player: Player = {
      id: playerId,
      userId: null,
      displayName,
      joinedAtMs: this.now(),
      isReady: false,
      score: 0,
      streak: 0,
      maxStreak: 0,
      totalResponseMs: 0,
      correctAnswers: 0,
      library: defaultPlayerLibraryState(),
    };

    session.players.set(playerId, player);
    this.ensureHost(session);
    this.resetReadyStates(session);

    return {
      status: "ok" as const,
      value: {
        ok: true as const,
        playerId,
        playerCount: session.players.size,
        hostPlayerId: session.hostPlayerId,
      },
    };
  }

  joinRoomAsUser(
    roomCode: string,
    displayName: string,
    userId: string | null,
    linkedProviders?: Partial<Record<LibraryProvider, { status: ProviderLinkStatus; estimatedTrackCount: number | null }>>,
  ) {
    const joined = this.joinRoom(roomCode, displayName);
    if (joined.status !== "ok") return joined;

    const session = this.rooms.get(roomCode);
    const player = session?.players.get(joined.value.playerId);
    if (player) {
      player.userId = userId;
      if (linkedProviders) {
        for (const provider of ["spotify", "deezer"] as const) {
          const entry = linkedProviders[provider];
          if (!entry) continue;
          player.library.linkedProviders[provider] = normalizeProviderLinkStatus(entry.status);
          player.library.estimatedTrackCount[provider] =
            typeof entry.estimatedTrackCount === "number" && Number.isFinite(entry.estimatedTrackCount)
              ? Math.max(0, Math.floor(entry.estimatedTrackCount))
              : null;
        }
        player.library.syncStatus = "ready";
      }
    }
    if (session?.sourceMode === "players_liked") {
      this.startPlayersLikedPoolBuild(session);
    }

    return joined.value;
  }

  setRoomSource(roomCode: string, playerId: string, categoryQuery: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };
    this.ensureHost(session);
    if (!session.players.has(playerId)) return { status: "player_not_found" as const };
    if (session.hostPlayerId !== playerId) return { status: "forbidden" as const };
    if (session.manager.state() !== "waiting") return { status: "invalid_state" as const };

    const normalized = categoryQuery.trim();
    if (normalized.length <= 0) return { status: "invalid_payload" as const };

    session.sourceMode = "public_playlist";
    if (normalized.toLowerCase().startsWith("deezer:playlist:")) {
      const id = normalized.slice("deezer:playlist:".length).trim();
      session.publicPlaylistSelection = {
        provider: "deezer",
        id,
        name: normalized,
        trackCount: null,
        sourceQuery: normalized,
        selectedByPlayerId: playerId,
      };
    } else {
      session.publicPlaylistSelection = null;
    }
    session.playersLikedPool = [];
    session.distractorTrackPool = [];
    this.roomLikedPoolRebuildRequested.delete(roomCode);
    session.poolBuild = {
      status: "idle",
      contributorsCount: 0,
      playableTracksCount: 0,
      lastBuiltAtMs: null,
      errorCode: null,
    };
    session.categoryQuery = normalized;
    this.resetReadyStates(session);
    return { status: "ok" as const, categoryQuery: normalized };
  }

  setRoomSourceMode(roomCode: string, playerId: string, mode: RoomSourceMode) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };
    this.ensureHost(session);
    if (!session.players.has(playerId)) return { status: "player_not_found" as const };
    if (session.hostPlayerId !== playerId) return { status: "forbidden" as const };
    if (session.manager.state() !== "waiting") return { status: "invalid_state" as const };

    session.sourceMode = mode;
    if (mode === "public_playlist") {
      session.playersLikedPool = [];
      session.distractorTrackPool = [];
      this.roomLikedPoolRebuildRequested.delete(roomCode);
      session.poolBuild = {
        status: "idle",
        contributorsCount: 0,
        playableTracksCount: 0,
        lastBuiltAtMs: null,
        errorCode: null,
      };
      if (session.publicPlaylistSelection?.sourceQuery) {
        session.categoryQuery = session.publicPlaylistSelection.sourceQuery;
      } else if (session.categoryQuery === "players:liked") {
        session.categoryQuery = "";
      }
    } else {
      session.publicPlaylistSelection = null;
      session.categoryQuery = "players:liked";
      this.startPlayersLikedPoolBuild(session);
    }
    this.resetReadyStates(session);
    return { status: "ok" as const, mode: session.sourceMode };
  }

  setRoomPublicPlaylist(
    roomCode: string,
    playerId: string,
    selection: { id: string; name: string; trackCount: number | null; sourceQuery?: string },
  ) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };
    this.ensureHost(session);
    if (!session.players.has(playerId)) return { status: "player_not_found" as const };
    if (session.hostPlayerId !== playerId) return { status: "forbidden" as const };
    if (session.manager.state() !== "waiting") return { status: "invalid_state" as const };
    const id = selection.id.trim();
    if (id.length <= 0) return { status: "invalid_payload" as const };

    const sourceQuery = selection.sourceQuery?.trim().length
      ? selection.sourceQuery.trim()
      : `deezer:playlist:${id}`;
    session.sourceMode = "public_playlist";
    session.publicPlaylistSelection = {
      provider: "deezer",
      id,
      name: selection.name.trim().length > 0 ? selection.name.trim() : id,
      trackCount:
        typeof selection.trackCount === "number" && Number.isFinite(selection.trackCount)
          ? Math.max(0, Math.floor(selection.trackCount))
          : null,
      sourceQuery,
      selectedByPlayerId: playerId,
    };
    session.playersLikedPool = [];
    session.distractorTrackPool = [];
    this.roomLikedPoolRebuildRequested.delete(roomCode);
    session.poolBuild = {
      status: "idle",
      contributorsCount: 0,
      playableTracksCount: 0,
      lastBuiltAtMs: null,
      errorCode: null,
    };
    session.categoryQuery = sourceQuery;
    this.resetReadyStates(session);
    return {
      status: "ok" as const,
      categoryQuery: session.categoryQuery,
      sourceMode: session.sourceMode,
    };
  }

  setPlayerLibraryContribution(
    roomCode: string,
    playerId: string,
    provider: LibraryProvider,
    includeInPool: boolean,
  ) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };
    if (session.manager.state() !== "waiting") return { status: "invalid_state" as const };
    const player = session.players.get(playerId);
    if (!player) return { status: "player_not_found" as const };
    if (!player.userId) return { status: "forbidden" as const };

    player.library.includeInPool[provider] = includeInPool;
    if (session.sourceMode === "players_liked") {
      session.poolBuild.status = "building";
      session.poolBuild.errorCode = null;
      this.startPlayersLikedPoolBuild(session);
    }
    this.resetReadyStates(session);
    return {
      status: "ok" as const,
      includeInPool: player.library.includeInPool[provider],
    };
  }

  setPlayerLibraryLinks(
    roomCode: string,
    playerId: string,
    links: Partial<Record<LibraryProvider, { status: ProviderLinkStatus; estimatedTrackCount: number | null }>>,
  ) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };
    const player = session.players.get(playerId);
    if (!player) return { status: "player_not_found" as const };

    player.library.syncStatus = "ready";
    player.library.lastError = null;
    for (const provider of ["spotify", "deezer"] as const) {
      const next = links[provider];
      if (!next) continue;
      player.library.linkedProviders[provider] = normalizeProviderLinkStatus(next.status);
      player.library.estimatedTrackCount[provider] =
        typeof next.estimatedTrackCount === "number" && Number.isFinite(next.estimatedTrackCount)
          ? Math.max(0, Math.floor(next.estimatedTrackCount))
          : null;
      if (player.library.linkedProviders[provider] !== "linked") {
        player.library.includeInPool[provider] = false;
      }
    }

    if (session.sourceMode === "players_liked") {
      session.poolBuild.status = "building";
      session.poolBuild.errorCode = null;
      this.startPlayersLikedPoolBuild(session);
    }

    return {
      status: "ok" as const,
      linkedProviders: {
        spotify: player.library.linkedProviders.spotify,
        deezer: player.library.linkedProviders.deezer,
      },
    };
  }

  setPlayerReady(roomCode: string, playerId: string, ready: boolean) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };
    const player = session.players.get(playerId);
    if (!player) return { status: "player_not_found" as const };
    if (session.manager.state() !== "waiting") return { status: "invalid_state" as const };
    player.isReady = ready;
    return { status: "ok" as const, isReady: player.isReady };
  }

  kickPlayer(roomCode: string, hostPlayerId: string, targetPlayerId: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };
    this.ensureHost(session);
    if (!session.players.has(hostPlayerId)) return { status: "player_not_found" as const };
    if (session.hostPlayerId !== hostPlayerId) return { status: "forbidden" as const };
    if (session.manager.state() !== "waiting") return { status: "invalid_state" as const };
    if (hostPlayerId === targetPlayerId) return { status: "invalid_payload" as const };
    if (!session.players.has(targetPlayerId)) return { status: "target_not_found" as const };

    session.players.delete(targetPlayerId);
    this.ensureHost(session);
    this.resetReadyStates(session);
    if (session.sourceMode === "players_liked") {
      this.startPlayersLikedPoolBuild(session);
    }
    return { status: "ok" as const, playerCount: session.players.size };
  }

  removePlayer(roomCode: string, playerId: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };
    if (!session.players.has(playerId)) return { status: "player_not_found" as const };

    session.players.delete(playerId);
    if (session.players.size <= 0) {
      this.stopPreloadJob(roomCode);
      this.stopPlayersLikedPoolJob(roomCode);
      this.roomLikedPoolRebuildRequested.delete(roomCode);
      this.rooms.delete(roomCode);
      return { status: "ok" as const, playerCount: 0, hostPlayerId: null };
    }
    this.ensureHost(session);
    if (session.manager.state() === "waiting") {
      this.resetReadyStates(session);
      if (session.sourceMode === "players_liked") {
        this.startPlayersLikedPoolBuild(session);
      }
    }

    return { status: "ok" as const, playerCount: session.players.size, hostPlayerId: session.hostPlayerId };
  }

  replayRoom(roomCode: string, playerId: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };
    this.ensureHost(session);
    if (!session.players.has(playerId)) return { status: "player_not_found" as const };
    if (session.hostPlayerId !== playerId) return { status: "forbidden" as const };
    if (session.manager.state() !== "results") return { status: "invalid_state" as const };

    this.stopPreloadJob(roomCode);
    this.stopPlayersLikedPoolJob(roomCode);
    this.roomLikedPoolRebuildRequested.delete(roomCode);
    session.manager.resetToWaiting();
    session.trackPool = [];
    session.distractorTrackPool = [];
    session.totalRounds = 0;
    session.roundModes = [];
    session.roundChoices.clear();
    session.latestReveal = null;
    session.sourceMode = "public_playlist";
    session.publicPlaylistSelection = null;
    session.playersLikedPool = [];
    session.poolBuild = {
      status: "idle",
      contributorsCount: 0,
      playableTracksCount: 0,
      lastBuiltAtMs: null,
      errorCode: null,
    };
    session.categoryQuery = "";
    this.resetReadyStates(session);

    for (const player of session.players.values()) {
      player.score = 0;
      player.streak = 0;
      player.maxStreak = 0;
      player.totalResponseMs = 0;
      player.correctAnswers = 0;
      player.library.includeInPool.spotify = false;
      player.library.includeInPool.deezer = false;
    }

    return {
      status: "ok" as const,
      roomCode: session.roomCode,
      state: session.manager.state(),
      playerCount: session.players.size,
      categoryQuery: session.categoryQuery,
    };
  }

  async startGame(roomCode: string, playerId: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return null;
    this.ensureHost(session);

    if (!session.players.has(playerId)) {
      return {
        ok: false as const,
        error: "PLAYER_NOT_FOUND" as const,
      };
    }
    if (session.hostPlayerId !== playerId) {
      return {
        ok: false as const,
        error: "HOST_ONLY" as const,
      };
    }
    if (session.manager.state() !== "waiting") {
      return {
        ok: false as const,
        error: "INVALID_STATE" as const,
      };
    }
    if (session.players.size <= 0) {
      return {
        ok: false as const,
        error: "NO_PLAYERS" as const,
      };
    }
    const allReady = [...session.players.values()].every((player) => player.isReady);
    if (!allReady) {
      return {
        ok: false as const,
        error: "PLAYERS_NOT_READY" as const,
      };
    }

    const poolSize = Math.max(1, this.config.maxRounds);
    if (session.sourceMode === "public_playlist") {
      const sourceQuery = this.sourceQueryForSession(session);
      if (sourceQuery.length <= 0) {
        return {
          ok: false as const,
          error: "SOURCE_NOT_SET" as const,
        };
      }
    } else {
      const contributors = this.playersLikedContributors(session);
      if (contributors.length < session.playersLikedRules.minContributors) {
        return {
          ok: false as const,
          error: "PLAYERS_LIBRARY_NOT_READY" as const,
        };
      }
      if (session.poolBuild.status === "building") {
        const waitDeadlineMs = Date.now() + 12_000;
        while (session.poolBuild.status === "building") {
          const inFlight = this.roomLikedPoolJobs.get(roomCode);
          if (!inFlight) break;
          const remainingMs = waitDeadlineMs - Date.now();
          if (remainingMs <= 0) break;
          try {
            await withTimeout(inFlight, remainingMs, "PLAYERS_LIBRARY_SYNC_TIMEOUT");
          } catch {
            // Keep fallback error below when queued jobs do not finish in time.
            break;
          }
        }
        if (session.poolBuild.status === "building") {
          return {
            ok: false as const,
            error: "PLAYERS_LIBRARY_SYNCING" as const,
          };
        }
      }
    }

    const resolvedQuery = this.sourceQueryForSession(session);
    const startupLoadStartedAt = Date.now();
    logEvent("info", "room_start_trackpool_loading_begin", {
      roomCode,
      categoryQuery: resolvedQuery,
      startupPoolSize: poolSize,
      requestedRounds: poolSize,
      players: session.players.size,
    });

    let startPoolStats: {
      tracks: MusicTrack[];
      distractorTracks: MusicTrack[];
      candidateCount: number;
      rawTotal: number;
      playableTotal: number;
      cleanTotal: number;
    };
    try {
      startPoolStats = session.sourceMode === "players_liked"
        ? await this.buildPlayersLikedTrackPool(session, poolSize)
        : await this.buildStartTrackPool(resolvedQuery, poolSize);
    } catch (error) {
      if (error instanceof Error && error.message === SPOTIFY_RATE_LIMITED_ERROR) {
        return {
          ok: false as const,
          error: "SPOTIFY_RATE_LIMITED" as const,
          retryAfterMs: spotifyPlaylistRateLimitRetryAfterMs(),
        };
      }

      logEvent("warn", "room_start_trackpool_loading_failed", {
        roomCode,
        categoryQuery: resolvedQuery,
        startupPoolSize: poolSize,
        requestedRounds: poolSize,
        durationMs: Date.now() - startupLoadStartedAt,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
        youtubeProviderMetrics: providerMetricsSnapshot().youtube ?? null,
        spotifyProviderMetrics: providerMetricsSnapshot().spotify ?? null,
      });
      return {
        ok: false as const,
        error: "NO_TRACKS_FOUND" as const,
      };
    }

    logEvent("info", "room_start_trackpool_loading_done", {
      roomCode,
      categoryQuery: resolvedQuery,
      startupPoolSize: poolSize,
      requestedRounds: poolSize,
      durationMs: Date.now() - startupLoadStartedAt,
      rawTrackPoolSize: startPoolStats.rawTotal,
      playablePoolSize: startPoolStats.playableTotal,
      cleanPoolSize: startPoolStats.cleanTotal,
      selectedPoolSize: startPoolStats.tracks.length,
      distractorPoolSize: startPoolStats.distractorTracks.length,
      candidatePoolSize: startPoolStats.candidateCount,
    });

    session.trackPool = startPoolStats.tracks;
    session.distractorTrackPool = startPoolStats.distractorTracks;
    if (session.sourceMode === "players_liked") {
      session.playersLikedPool = [...startPoolStats.tracks, ...startPoolStats.distractorTracks];
      session.poolBuild.status = startPoolStats.tracks.length > 0 ? "ready" : "failed";
      session.poolBuild.contributorsCount = this.playersLikedContributors(session).length;
      session.poolBuild.playableTracksCount = startPoolStats.candidateCount;
      session.poolBuild.lastBuiltAtMs = this.now();
      session.poolBuild.errorCode = startPoolStats.tracks.length > 0 ? null : "NO_TRACKS_FOUND";
    }
    session.latestReveal = null;
    this.refreshRoundPlan(session);

    if (session.totalRounds < poolSize || session.trackPool.length < poolSize) {
      if (
        session.sourceMode === "public_playlist" &&
        resolvedQuery.toLowerCase().startsWith("spotify:") &&
        this.isSpotifyRateLimitedRecently()
      ) {
        return {
          ok: false as const,
          error: "SPOTIFY_RATE_LIMITED" as const,
          retryAfterMs: spotifyPlaylistRateLimitRetryAfterMs(),
        };
      }

      logEvent("warn", "room_start_no_tracks", {
        roomCode,
        categoryQuery: resolvedQuery,
        reason: session.trackPool.length <= 0 ? "EMPTY_POOL" : "INSUFFICIENT_POOL",
        requestedPoolSize: poolSize,
        selectedPoolSize: session.trackPool.length,
        distractorPoolSize: session.distractorTrackPool.length,
        candidatePoolSize: startPoolStats.candidateCount,
        missingTracks: Math.max(0, poolSize - session.trackPool.length),
        preparedRounds: session.totalRounds,
        rawTrackPoolSize: startPoolStats.rawTotal,
        playablePoolSize: startPoolStats.playableTotal,
        cleanPoolSize: startPoolStats.cleanTotal,
        youtubeProviderMetrics: providerMetricsSnapshot().youtube ?? null,
        spotifyProviderMetrics: providerMetricsSnapshot().spotify ?? null,
        players: session.players.size,
      });
      return {
        ok: false as const,
        error: "NO_TRACKS_FOUND" as const,
      };
    }

    session.roundChoices.clear();
    for (let round = 1; round <= session.totalRounds; round += 1) {
      if (session.roundModes[round - 1] === "mcq") this.buildRoundChoices(session, round);
    }

    for (const player of session.players.values()) {
      player.score = 0;
      player.streak = 0;
      player.maxStreak = 0;
      player.totalResponseMs = 0;
      player.correctAnswers = 0;
      player.isReady = false;
    }

    const tracksWithPreview = session.trackPool.filter((track) => hasAudioPreview(track)).length;
    const tracksWithYouTube = session.trackPool.filter((track) => hasYouTubePlayback(track)).length;
    logEvent("info", "room_start_audio_preview_coverage", {
      roomCode,
      categoryQuery: resolvedQuery,
      poolSize: session.trackPool.length,
      distractorPoolSize: session.distractorTrackPool.length,
      candidatePoolSize: startPoolStats.candidateCount,
      rawPoolSize: startPoolStats.rawTotal,
      playablePoolSize: startPoolStats.playableTotal,
      removedPromotionalTracks: Math.max(
        0,
        startPoolStats.playableTotal - startPoolStats.cleanTotal,
      ),
      previewCount: tracksWithPreview,
      youtubePlaybackCount: tracksWithYouTube,
      players: session.players.size,
    });

    session.manager.startGame({
      nowMs: this.now(),
      countdownMs: this.config.countdownMs,
      totalRounds: session.totalRounds,
    });

    this.progressSession(session, this.now());

    return {
      ok: true as const,
      state: session.manager.state(),
      poolSize: session.trackPool.length,
      categoryQuery: session.categoryQuery,
      sourceMode: session.sourceMode,
      totalRounds: session.totalRounds,
      deadlineMs: session.manager.deadlineMs(),
    };
  }

  skipCurrentRound(roomCode: string, playerId: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };
    this.ensureHost(session);
    if (!session.players.has(playerId)) return { status: "player_not_found" as const };
    if (session.hostPlayerId !== playerId) return { status: "forbidden" as const };

    const nowMs = this.now();
    this.progressSession(session, nowMs);
    if (session.manager.state() !== "playing") return { status: "invalid_state" as const };

    const skipped = session.manager.skipPlayingRound({
      nowMs,
      roundMs: this.config.playingMs,
    });
    if (!skipped.skipped || !skipped.closedRound) {
      return { status: "invalid_state" as const };
    }

    this.applyRoundResults(session, skipped.closedRound);
    return {
      status: "ok" as const,
      state: session.manager.state(),
      round: session.manager.round(),
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

  playerUserId(roomCode: string, playerId: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return null;
    const player = session.players.get(playerId);
    return player?.userId ?? null;
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
    const hostPlayerId = this.ensureHost(session);
    const players = this.sortedPlayers(session).map((player) => ({
      playerId: player.id,
      displayName: player.displayName,
      isReady: player.isReady,
      isHost: player.id === hostPlayerId,
      canContributeLibrary: Boolean(player.userId),
      libraryContribution: {
        includeInPool: {
          spotify: player.library.includeInPool.spotify,
          deezer: player.library.includeInPool.deezer,
        },
        linkedProviders: {
          spotify: player.library.linkedProviders.spotify,
          deezer: player.library.linkedProviders.deezer,
        },
        estimatedTrackCount: {
          spotify: player.library.estimatedTrackCount.spotify,
          deezer: player.library.estimatedTrackCount.deezer,
        },
        syncStatus: player.library.syncStatus,
        lastError: player.library.lastError,
      },
    }));
    const readyCount = players.filter((player) => player.isReady).length;
    const allReady = players.length > 0 && readyCount === players.length;
    const canStart = this.canStartWaitingSession(session);
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
      hostPlayerId,
      players,
      readyCount,
      allReady,
      canStart,
      poolSize: session.trackPool.length,
      categoryQuery: session.categoryQuery,
      sourceMode: session.sourceMode,
      sourceConfig: {
        mode: session.sourceMode,
        publicPlaylist: session.publicPlaylistSelection
          ? {
              provider: session.publicPlaylistSelection.provider,
              id: session.publicPlaylistSelection.id,
              name: session.publicPlaylistSelection.name,
              trackCount: session.publicPlaylistSelection.trackCount,
              sourceQuery: session.publicPlaylistSelection.sourceQuery,
              selectedByPlayerId: session.publicPlaylistSelection.selectedByPlayerId,
            }
          : null,
        playersLikedRules: {
          minContributors: session.playersLikedRules.minContributors,
          minTotalTracks: session.playersLikedRules.minTotalTracks,
        },
      },
      poolBuild: {
        status: session.poolBuild.status,
        contributorsCount: session.poolBuild.contributorsCount,
        playableTracksCount: session.poolBuild.playableTracksCount,
        lastBuiltAtMs: session.poolBuild.lastBuiltAtMs,
        errorCode: session.poolBuild.errorCode,
      },
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
        canJoin: true,
        deadlineMs: session.manager.deadlineMs(),
        serverNowMs: nowMs,
      });
    }

    return rooms.sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 50);
  }
}

export const roomStore = new RoomStore();
