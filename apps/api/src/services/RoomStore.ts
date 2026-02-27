import { isTextAnswerCorrect } from "./FuzzyMatcher";
import { logEvent } from "../lib/logger";
import { providerMetricsSnapshot } from "../lib/provider-metrics";
import { applyScore } from "./ScoreCalculator";
import { hasAudioPreview, hasYouTubePlayback, isTrackPlayable } from "./PlaybackSupport";
import type { ClosedRound, GameState } from "./RoomManager";
import { RoomManager } from "./RoomManager";
import { trackCache } from "./TrackCache";
import type { MusicTrack } from "./music-types";
import { getRomanizedJapaneseCached, scheduleRomanizeJapanese } from "./JapaneseRomanizer";
import { SPOTIFY_RATE_LIMITED_ERROR, spotifyPlaylistRateLimitRetryAfterMs } from "../routes/music/spotify";
import { fetchUserLikedTracksForProviders as fetchSyncedUserLikedTracksForProviders } from "./UserMusicLibrary";
import { userLikedTrackRepository } from "../repositories/UserLikedTrackRepository";

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
  lastRoundScore: number;
  streak: number;
  maxStreak: number;
  totalResponseMs: number;
  correctAnswers: number;
  library: PlayerLibraryState;
};

type RoomChatMessage = {
  id: string;
  playerId: string;
  displayName: string;
  text: string;
  sentAtMs: number;
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
    mergedTracksCount: number;
    playableTracksCount: number;
    lastBuiltAtMs: number | null;
    errorCode: string | null;
  };
  isResolvingTracks: boolean;
  trackResolutionJobsInFlight: number;
  categoryQuery: string;
  totalRounds: number;
  roundModes: RoundMode[];
  roundChoices: Map<number, string[]>;
  latestReveal: {
    round: number;
    trackId: string;
    title: string;
    titleRomaji: string | null;
    artist: string;
    artistRomaji: string | null;
    provider: MusicTrack["provider"];
    mode: RoundMode;
    acceptedAnswer: string;
    previewUrl: string | null;
    sourceUrl: string | null;
    embedUrl: string | null;
    choices: string[] | null;
    playerAnswers: Array<{
      playerId: string;
      displayName: string;
      answer: string | null;
      submitted: boolean;
      isCorrect: boolean;
    }>;
  } | null;
  chatMessages: RoomChatMessage[];
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
const PLAYERS_LIKED_TARGET_BUFFER = 2;
const YOUTUBE_RANDOM_START_MIN_SEC = 18;
const YOUTUBE_RANDOM_START_END_BUFFER_SEC = 20;
const YOUTUBE_RANDOM_START_MIN_DURATION_SEC = 45;
const MCQ_REQUIRED_CHOICES = 4;
const START_POOL_RETRY_ATTEMPTS = 3;
const START_POOL_RETRY_DELAY_MS = 900;
const PLAYERS_LIKED_POOL_BUILD_TIMEOUT_MS = 45_000;
const ROOM_ANSWER_SUGGESTION_LIMIT = 1_000;
const ROOM_BULK_ANSWER_TRACK_LIMIT = 16_000;
const ROOM_BULK_ANSWER_SUGGESTION_LIMIT = 24_000;

type RoundConfig = typeof DEFAULT_ROUND_CONFIG;

type RoomStoreDependencies = {
  now?: () => number;
  getTrackPool?: (categoryQuery: string, size: number) => Promise<MusicTrack[]>;
  getPlayerLikedTracks?: (input: {
    userId: string;
    providers: LibraryProvider[];
    size: number;
    allowExternalResolve?: boolean;
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

function collectAnswerVariants(track: MusicTrack) {
  const variants = new Set<string>();

  const push = (value: string | null | undefined) => {
    const normalized = value?.trim() ?? "";
    if (normalized.length <= 0) return;
    variants.add(normalized);
  };

  push(track.title);
  push(track.artist);
  push(`${track.title} ${track.artist}`);
  push(asChoiceLabel(track));

  const titleRomaji = getRomanizedJapaneseCached(track.title);
  const artistRomaji = getRomanizedJapaneseCached(track.artist);
  push(titleRomaji);
  push(artistRomaji);

  if (titleRomaji && artistRomaji) {
    push(`${titleRomaji} ${artistRomaji}`);
    push(`${titleRomaji} - ${artistRomaji}`);
  }
  if (titleRomaji) {
    push(`${titleRomaji} ${track.artist}`);
    push(`${titleRomaji} - ${track.artist}`);
  }
  if (artistRomaji) {
    push(`${track.title} ${artistRomaji}`);
    push(`${track.title} - ${artistRomaji}`);
  }

  return [...variants];
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

function collectRoomAnswerSuggestions(
  tracks: Array<Pick<MusicTrack, "title" | "artist">>,
  limit = ROOM_ANSWER_SUGGESTION_LIMIT,
) {
  const values: string[] = [];
  const seen = new Set<string>();

  const push = (value: string | null | undefined) => {
    const normalized = value?.trim() ?? "";
    if (normalized.length < 2) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    values.push(normalized);
  };

  for (const track of tracks) {
    const title = track.title.trim();
    const artist = track.artist.trim();
    const titleRomaji = getRomanizedJapaneseCached(title);
    const artistRomaji = getRomanizedJapaneseCached(artist);

    push(title);
    push(artist);
    push(titleRomaji);
    push(artistRomaji);

    if (values.length >= limit) break;
  }

  return values.slice(0, limit);
}

type TrackLanguageGroup = "japanese" | "korean" | "french" | "english" | "latin" | "other";
type TrackGenreGroup =
  | "metal"
  | "rock"
  | "pop"
  | "jpop"
  | "kpop"
  | "rap"
  | "electro"
  | "other";
type TrackVocalGroup = "female" | "male" | "mixed" | "unknown";

type TrackChoiceProfile = {
  language: TrackLanguageGroup;
  genre: TrackGenreGroup;
  vocal: TrackVocalGroup;
};

const JAPANESE_SCRIPT_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u;
const KOREAN_SCRIPT_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;
const FRENCH_WORD_HINTS = new Set([
  "le", "la", "les", "de", "des", "du", "une", "un", "et", "avec", "pour", "dans", "sur", "pas", "plus",
  "toi", "moi", "amour", "coeur", "vie", "nuit", "jour", "toujours", "jamais", "sans", "mon", "ma", "mes",
  "ton", "ta", "tes", "notre", "votre", "que", "qui", "est",
]);
const ENGLISH_WORD_HINTS = new Set([
  "the", "and", "of", "to", "in", "on", "for", "with", "my", "your", "you", "me", "we", "they", "is", "are",
  "love", "night", "day", "heart", "never", "always", "without", "from", "this", "that",
]);

const GENRE_PATTERNS: Array<{ genre: TrackGenreGroup; regex: RegExp }> = [
  { genre: "metal", regex: /\b(metal|deathcore|metalcore|thrash|black metal|heavy metal)\b/i },
  { genre: "rock", regex: /\b(rock|punk|grunge|alt rock|indie rock|hard rock)\b/i },
  { genre: "kpop", regex: /\b(k-pop|kpop)\b/i },
  { genre: "jpop", regex: /\b(j-pop|jpop|anisong|anime opening|anime op)\b/i },
  { genre: "rap", regex: /\b(rap|hip hop|hip-hop|trap|drill|freestyle)\b/i },
  { genre: "electro", regex: /\b(edm|electro|house|techno|trance|dubstep|drum ?& ?bass|dnb)\b/i },
  { genre: "pop", regex: /\b(pop|radio edit|mainstream)\b/i },
];

const FEMALE_VOCAL_HINTS = [
  "girls",
  "girl",
  "women",
  "woman",
  "sisters",
  "queen",
  "princess",
  "diva",
];

const MALE_VOCAL_HINTS = [
  "boys",
  "boy",
  "men",
  "man",
  "brothers",
  "king",
  "prince",
];

const FEMALE_FIRST_NAMES = new Set([
  "adele",
  "ariana",
  "ava",
  "aya",
  "billie",
  "camila",
  "charli",
  "dua",
  "ellie",
  "halsey",
  "jennie",
  "jisoo",
  "karina",
  "lisa",
  "lorde",
  "momo",
  "olivia",
  "rihanna",
  "rosalia",
  "sabrina",
  "sana",
  "shakira",
  "sia",
  "taylor",
  "yuna",
  "yui",
]);

const MALE_FIRST_NAMES = new Set([
  "bruno",
  "drake",
  "ed",
  "eminem",
  "harry",
  "jay",
  "jimin",
  "jungkook",
  "kendrick",
  "post",
  "suga",
  "taemin",
  "theweeknd",
  "travis",
  "weeknd",
]);

function firstArtistToken(value: string) {
  const normalized = normalizeChoiceText(value).replace(/[^a-z0-9 ]+/g, " ").trim();
  return normalized.split(/\s+/).find((token) => token.length > 0) ?? "";
}

function normalizeChoiceText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function detectLanguageGroup(track: Pick<MusicTrack, "title" | "artist">): TrackLanguageGroup {
  const text = `${track.title} ${track.artist}`;
  if (JAPANESE_SCRIPT_RE.test(text)) return "japanese";
  if (KOREAN_SCRIPT_RE.test(text)) return "korean";

  const normalized = normalizeChoiceText(text);
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length > 0) {
    let frenchHits = 0;
    let englishHits = 0;
    for (const token of tokens) {
      if (FRENCH_WORD_HINTS.has(token)) frenchHits += 1;
      if (ENGLISH_WORD_HINTS.has(token)) englishHits += 1;
    }
    if (frenchHits >= 2 && frenchHits >= englishHits + 1) return "french";
    if (englishHits >= 2 && englishHits >= frenchHits + 1) return "english";
  }
  if (/^[\x00-\x7f\s\W]+$/.test(normalized)) return "latin";
  return "other";
}

function detectGenreGroup(track: Pick<MusicTrack, "title" | "artist">): TrackGenreGroup {
  const normalized = normalizeChoiceText(`${track.title} ${track.artist}`);
  for (const rule of GENRE_PATTERNS) {
    if (rule.regex.test(normalized)) return rule.genre;
  }
  if (JAPANESE_SCRIPT_RE.test(`${track.title} ${track.artist}`)) return "jpop";
  if (KOREAN_SCRIPT_RE.test(`${track.title} ${track.artist}`)) return "kpop";
  return "other";
}

function detectVocalGroup(track: Pick<MusicTrack, "artist">): TrackVocalGroup {
  const artist = normalizeChoiceText(track.artist);
  const hasSplitMarkers = /\b(feat|ft|x|&|and|vs)\b/i.test(artist) || /[,/]/.test(artist);
  if (hasSplitMarkers) return "mixed";
  if (FEMALE_VOCAL_HINTS.some((hint) => artist.includes(hint))) return "female";
  if (MALE_VOCAL_HINTS.some((hint) => artist.includes(hint))) return "male";
  const firstToken = firstArtistToken(track.artist);
  if (FEMALE_FIRST_NAMES.has(firstToken)) return "female";
  if (MALE_FIRST_NAMES.has(firstToken)) return "male";
  return "unknown";
}

function buildChoiceProfile(track: Pick<MusicTrack, "title" | "artist">): TrackChoiceProfile {
  return {
    language: detectLanguageGroup(track),
    genre: detectGenreGroup(track),
    vocal: detectVocalGroup(track),
  };
}

function choiceCoherenceScore(
  source: TrackChoiceProfile,
  candidate: TrackChoiceProfile,
  sourceTrack: Pick<MusicTrack, "artist">,
  candidateTrack: Pick<MusicTrack, "artist">,
) {
  let score = 0;
  if (source.language === candidate.language) score += 80;
  if (source.genre === candidate.genre) score += 45;
  if (source.vocal !== "unknown" && source.vocal === candidate.vocal) score += 25;

  const sameArtist =
    normalizeChoiceText(sourceTrack.artist).trim() === normalizeChoiceText(candidateTrack.artist).trim();
  if (sameArtist) score -= 20;

  if (source.language === "french" && candidate.language === "english") score -= 55;
  if (source.language === "english" && candidate.language === "french") score -= 35;
  if (source.language === "french" && candidate.language !== "french") score -= 30;
  if (source.language === "english" && candidate.language !== "english" && candidate.language !== "latin") score -= 25;
  if (source.language === "japanese" && candidate.language !== "japanese") score -= 40;
  if (source.language === "korean" && candidate.language !== "korean") score -= 35;
  if (source.genre !== "other" && candidate.genre !== source.genre) score -= 15;

  return score;
}

function minChoiceCoherenceScore(language: TrackLanguageGroup) {
  if (language === "japanese" || language === "korean" || language === "french") return 35;
  return 15;
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

function stableHash(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function deterministicIntFromSeed(seed: string, min: number, max: number) {
  const safeMin = Math.max(0, Math.floor(min));
  const safeMax = Math.max(safeMin, Math.floor(max));
  const size = safeMax - safeMin + 1;
  if (size <= 1) return safeMin;
  return safeMin + (stableHash(seed) % size);
}

function youtubeRoundStartSeconds(
  track: Pick<MusicTrack, "id" | "durationSec">,
  context: { roomCode: string; round: number },
) {
  const durationSec =
    typeof track.durationSec === "number" && Number.isFinite(track.durationSec)
      ? Math.max(0, Math.floor(track.durationSec))
      : null;

  if (durationSec !== null && durationSec < YOUTUBE_RANDOM_START_MIN_DURATION_SEC) {
    return 0;
  }
  if (durationSec === null) return 0;

  const minStart = YOUTUBE_RANDOM_START_MIN_SEC;
  const maxStart = Math.max(minStart, durationSec - YOUTUBE_RANDOM_START_END_BUFFER_SEC);
  const seed = `${context.roomCode}:${context.round}:${track.id}`;
  return deterministicIntFromSeed(seed, minStart, maxStart);
}

function embedUrlForTrack(
  track: Pick<MusicTrack, "provider" | "id" | "durationSec">,
  context?: { roomCode: string; round: number },
) {
  if (track.provider === "spotify") {
    return `https://open.spotify.com/embed/track/${track.id}?utm_source=kwizik`;
  }
  if (track.provider === "youtube") {
    const start = context ? youtubeRoundStartSeconds(track, context) : 0;
    return `https://www.youtube.com/embed/${track.id}?autoplay=1&controls=0&disablekb=1&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0&fs=0&enablejsapi=1&start=${start}`;
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

async function sleepMs(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
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
    allowExternalResolve?: boolean;
  }) => Promise<MusicTrack[]>;
  private readonly config: RoundConfig;

  constructor(dependencies: RoomStoreDependencies = {}) {
    this.now = dependencies.now ?? (() => Date.now());
    this.getTrackPool = dependencies.getTrackPool ?? ((categoryQuery, size) =>
      trackCache.getOrBuild(categoryQuery, size));
    this.getPlayerLikedTracks = dependencies.getPlayerLikedTracks ?? fetchSyncedUserLikedTracksForProviders;
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

  private hasSyncedLibraryTracks(player: Player, provider: LibraryProvider) {
    const estimated = player.library.estimatedTrackCount[provider];
    return typeof estimated === "number" && Number.isFinite(estimated) && estimated > 0;
  }

  private canUsePlayersLikedProvider(player: Player, provider: LibraryProvider) {
    if (!player.library.includeInPool[provider]) return false;
    if (player.library.linkedProviders[provider] === "linked") return true;
    return this.hasSyncedLibraryTracks(player, provider);
  }

  private playersLikedContributors(session: RoomSession) {
    return [...session.players.values()].filter((player) => {
      if (!player.userId) return false;
      const spotifyIncluded = this.canUsePlayersLikedProvider(player, "spotify");
      const deezerIncluded = this.canUsePlayersLikedProvider(player, "deezer");
      return spotifyIncluded || deezerIncluded;
    });
  }

  private canStartWaitingSession(session: RoomSession) {
    if (session.manager.state() !== "waiting") return false;
    if (session.isResolvingTracks) return false;
    if (session.players.size <= 0) return false;

    if (session.sourceMode === "public_playlist") {
      return this.sourceQueryForSession(session).length > 0;
    }

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
        lastRoundScore: player.lastRoundScore,
        streak: player.streak,
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
    const sourceProfile = buildChoiceProfile(track);
    const futureRoundTracks = session.trackPool.slice(round);
    const distractorCandidates = [...futureRoundTracks, ...session.distractorTrackPool]
      .filter((candidate) => asChoiceLabel(candidate) !== correct)
      .map((candidate) => ({
        label: asChoiceLabel(candidate),
        track: candidate,
        profile: buildChoiceProfile(candidate),
      }));
    const rankedDistractors = randomShuffle(distractorCandidates)
      .map((entry) => ({
        ...entry,
        score: choiceCoherenceScore(sourceProfile, entry.profile, track, entry.track),
      }))
      .sort((left, right) => right.score - left.score);
    const minimumScore = minChoiceCoherenceScore(sourceProfile.language);

    const uniqueOptions = [correct];
    const seen = new Set(uniqueOptions);
    for (const distractor of rankedDistractors) {
      if (seen.has(distractor.label)) continue;
      if (distractor.score < minimumScore) continue;
      uniqueOptions.push(distractor.label);
      seen.add(distractor.label);
      if (uniqueOptions.length >= MCQ_REQUIRED_CHOICES) break;
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

  private async buildPlayersLikedTrackPool(
    session: RoomSession,
    requestedRounds: number,
    options: { allowExternalResolve?: boolean } = {},
  ) {
    const safeRounds = Math.max(1, requestedRounds);
    const allowExternalResolve = options.allowExternalResolve === true;
    // Keep players_liked startup close to requested rounds to avoid massive resolution bursts.
    const targetCandidateSize = Math.min(
      TRACK_POOL_MAX_CANDIDATES,
      safeRounds + PLAYERS_LIKED_TARGET_BUFFER,
    );
    const contributors = this.playersLikedContributors(session);
    const mergedTracks: MusicTrack[] = [];
    const seen = new Set<string>();
    let fetchedTotal = 0;

    for (const contributor of contributors) {
      const providers: LibraryProvider[] = [];
      if (this.canUsePlayersLikedProvider(contributor, "spotify")) {
        providers.push("spotify");
      }
      if (this.canUsePlayersLikedProvider(contributor, "deezer")) {
        providers.push("deezer");
      }
      if (!contributor.userId || providers.length <= 0) continue;

      const fetched = await withTimeout(
        this.getPlayerLikedTracks({
          userId: contributor.userId,
          providers,
          size: targetCandidateSize,
          allowExternalResolve,
        }),
        PLAYERS_LIKED_POOL_BUILD_TIMEOUT_MS,
        "PLAYERS_LIBRARY_TIMEOUT",
      );
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

  private async resolveTracksWithFlag<T>(session: RoomSession, task: () => Promise<T>) {
    session.trackResolutionJobsInFlight += 1;
    session.isResolvingTracks = true;
    try {
      return await task();
    } finally {
      session.trackResolutionJobsInFlight = Math.max(0, session.trackResolutionJobsInFlight - 1);
      session.isResolvingTracks = session.trackResolutionJobsInFlight > 0;
    }
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
    session.poolBuild.mergedTracksCount = 0;
    session.poolBuild.playableTracksCount = 0;
    session.poolBuild.errorCode = null;
    const buildJob = (async () => {
      await this.resolveTracksWithFlag(session, async () => {
        try {
          const built = await this.buildPlayersLikedTrackPool(session, desiredSize);
          if (session.sourceMode !== "players_liked") {
            return;
          }
          session.playersLikedPool = [...built.tracks, ...built.distractorTracks];
          session.poolBuild.status = built.tracks.length >= desiredSize ? "ready" : "failed";
          session.poolBuild.contributorsCount = built.contributorsCount;
          session.poolBuild.mergedTracksCount = built.playableTotal;
          session.poolBuild.playableTracksCount = built.candidateCount;
          session.poolBuild.lastBuiltAtMs = this.now();
          session.poolBuild.errorCode = built.tracks.length >= desiredSize ? null : "NO_TRACKS_FOUND";
        } catch (error) {
          session.playersLikedPool = [];
          session.poolBuild.status = "failed";
          session.poolBuild.contributorsCount = this.playersLikedContributors(session).length;
          session.poolBuild.mergedTracksCount = 0;
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
      });
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

    const variants = collectAnswerVariants(track);
    return variants.some((candidate) => isTextAnswerCorrect(answer, candidate));
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
    const playerRoundResults = new Map<
      string,
      { answer: string | null; submitted: boolean; isCorrect: boolean }
    >();

    for (const player of session.players.values()) {
      const submitted = round.answers.get(player.id);
      const isCorrect = submitted ? this.isAnswerCorrect(roundMode, submitted.value, track) : false;
      const responseMs =
        submitted && isCorrect ? Math.max(0, submitted.submittedAtMs - round.startedAtMs) : 0;
      const trimmedAnswer = submitted?.value.trim() ?? "";
      const scoring = applyScore({
        isCorrect,
        responseMs,
        streak: player.streak,
        baseScore: this.config.baseScore,
      });

      player.score += scoring.earned;
      player.lastRoundScore = scoring.earned;
      player.streak = scoring.nextStreak;
      player.maxStreak = Math.max(player.maxStreak, player.streak);

      if (isCorrect) {
        player.correctAnswers += 1;
        player.totalResponseMs += responseMs;
      }

      playerRoundResults.set(player.id, {
        answer: trimmedAnswer.length > 0 ? trimmedAnswer : null,
        submitted: Boolean(submitted),
        isCorrect,
      });
    }

    if (track) {
      scheduleRomanizeJapanese(track.title);
      scheduleRomanizeJapanese(track.artist);
    }

    const revealAnswers = this.sortedPlayers(session).map((player) => {
      const result = playerRoundResults.get(player.id);
      return {
        playerId: player.id,
        displayName: player.displayName,
        answer: result?.answer ?? null,
        submitted: result?.submitted ?? false,
        isCorrect: result?.isCorrect ?? false,
      };
    });

    session.latestReveal = track
      ? {
          round: round.round,
          trackId: track.id,
          title: track.title,
          titleRomaji: getRomanizedJapaneseCached(track.title),
          artist: track.artist,
          artistRomaji: getRomanizedJapaneseCached(track.artist),
          provider: track.provider,
          mode: roundMode,
          acceptedAnswer: asChoiceLabel(track),
          previewUrl: track.previewUrl,
          sourceUrl: track.sourceUrl,
          embedUrl: embedUrlForTrack(track, { roomCode: session.roomCode, round: round.round }),
          choices: roundChoices,
          playerAnswers: revealAnswers,
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
        minTotalTracks: 1,
      },
      playersLikedPool: [],
      poolBuild: {
        status: "idle",
        contributorsCount: 0,
        mergedTracksCount: 0,
        playableTracksCount: 0,
        lastBuiltAtMs: null,
        errorCode: null,
      },
      isResolvingTracks: false,
      trackResolutionJobsInFlight: 0,
      categoryQuery: options.categoryQuery?.trim() ?? "",
      totalRounds: 0,
      roundModes: [],
      roundChoices: new Map(),
      latestReveal: null,
      chatMessages: [],
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
      lastRoundScore: 0,
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
          player.library.includeInPool[provider] =
            player.library.linkedProviders[provider] === "linked" || this.hasSyncedLibraryTracks(player, provider);
        }
        player.library.syncStatus = "ready";
      }
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
      mergedTracksCount: 0,
      playableTracksCount: 0,
      lastBuiltAtMs: null,
      errorCode: null,
    };
    session.isResolvingTracks = false;
    session.trackResolutionJobsInFlight = 0;
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
        mergedTracksCount: 0,
        playableTracksCount: 0,
        lastBuiltAtMs: null,
        errorCode: null,
      };
      session.isResolvingTracks = false;
      session.trackResolutionJobsInFlight = 0;
      if (session.publicPlaylistSelection?.sourceQuery) {
        session.categoryQuery = session.publicPlaylistSelection.sourceQuery;
      } else if (session.categoryQuery === "players:liked") {
        session.categoryQuery = "";
      }
    } else {
      session.publicPlaylistSelection = null;
      session.categoryQuery = "players:liked";
      for (const player of session.players.values()) {
        for (const provider of ["spotify", "deezer"] as const) {
          if (player.library.linkedProviders[provider] === "linked" || this.hasSyncedLibraryTracks(player, provider)) {
            player.library.includeInPool[provider] = true;
          }
        }
      }
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
      mergedTracksCount: 0,
      playableTracksCount: 0,
      lastBuiltAtMs: null,
      errorCode: null,
    };
    session.isResolvingTracks = false;
    session.trackResolutionJobsInFlight = 0;
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
      session.poolBuild.status = "idle";
      session.poolBuild.mergedTracksCount = 0;
      session.poolBuild.playableTracksCount = 0;
      session.poolBuild.errorCode = null;
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
      player.library.includeInPool[provider] =
        player.library.linkedProviders[provider] === "linked" || this.hasSyncedLibraryTracks(player, provider);
    }

    if (session.sourceMode === "players_liked") {
      session.poolBuild.status = "idle";
      session.poolBuild.mergedTracksCount = 0;
      session.poolBuild.playableTracksCount = 0;
      session.poolBuild.errorCode = null;
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
    session.chatMessages = [];
    session.sourceMode = "public_playlist";
    session.publicPlaylistSelection = null;
    session.playersLikedPool = [];
    session.poolBuild = {
      status: "idle",
      contributorsCount: 0,
      mergedTracksCount: 0,
      playableTracksCount: 0,
      lastBuiltAtMs: null,
      errorCode: null,
    };
    session.isResolvingTracks = false;
    session.trackResolutionJobsInFlight = 0;
    session.categoryQuery = "";
    this.resetReadyStates(session);

    for (const player of session.players.values()) {
      player.score = 0;
      player.lastRoundScore = 0;
      player.streak = 0;
      player.maxStreak = 0;
      player.totalResponseMs = 0;
      player.correctAnswers = 0;
      player.library.includeInPool.spotify =
        player.library.linkedProviders.spotify === "linked" || this.hasSyncedLibraryTracks(player, "spotify");
      player.library.includeInPool.deezer =
        player.library.linkedProviders.deezer === "linked" || this.hasSyncedLibraryTracks(player, "deezer");
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
      if (session.poolBuild.status === "idle" || session.poolBuild.status === "failed") {
        this.startPlayersLikedPoolBuild(session);
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
            retryAfterMs: 1_500,
          };
        }
      }
    }
    const resolvedQuery = this.sourceQueryForSession(session);
    const isDeezerPlaylistSource =
      session.sourceMode === "public_playlist" && resolvedQuery.toLowerCase().startsWith("deezer:playlist:");
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
    const canReusePlayersLikedPool = session.sourceMode === "players_liked"
      && session.poolBuild.status === "ready"
      && session.playersLikedPool.length >= poolSize;

    if (canReusePlayersLikedPool) {
      const split = this.splitAnswerAndDistractorPools(session.playersLikedPool, poolSize);
      startPoolStats = {
        tracks: split.tracks,
        distractorTracks: split.distractorTracks,
        candidateCount: split.candidateCount,
        rawTotal: split.candidateCount,
        playableTotal: split.candidateCount,
        cleanTotal: split.candidateCount,
      };
      logEvent("info", "room_start_trackpool_reused_prebuilt", {
        roomCode,
        categoryQuery: resolvedQuery,
        startupPoolSize: poolSize,
        requestedRounds: poolSize,
        candidatePoolSize: split.candidateCount,
      });
    } else {
      try {
        startPoolStats = await this.resolveTracksWithFlag(
          session,
          async () => session.sourceMode === "players_liked"
            ? await this.buildPlayersLikedTrackPool(session, poolSize, { allowExternalResolve: true })
            : await this.buildStartTrackPool(resolvedQuery, poolSize),
        );
        for (
          let retryAttempt = 2;
          startPoolStats.tracks.length < poolSize && retryAttempt <= START_POOL_RETRY_ATTEMPTS;
          retryAttempt += 1
        ) {
          await sleepMs(START_POOL_RETRY_DELAY_MS);
          logEvent("info", "room_start_trackpool_retry", {
            roomCode,
            categoryQuery: resolvedQuery,
            requestedRounds: poolSize,
            retryAttempt,
            selectedPoolSize: startPoolStats.tracks.length,
            candidatePoolSize: startPoolStats.candidateCount,
          });
          startPoolStats = await this.resolveTracksWithFlag(
            session,
            async () => session.sourceMode === "players_liked"
              ? await this.buildPlayersLikedTrackPool(session, poolSize, { allowExternalResolve: true })
              : await this.buildStartTrackPool(resolvedQuery, poolSize),
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "UNKNOWN_ERROR";
        if (errorMessage === SPOTIFY_RATE_LIMITED_ERROR) {
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
          error: errorMessage,
          youtubeProviderMetrics: providerMetricsSnapshot().youtube ?? null,
          spotifyProviderMetrics: providerMetricsSnapshot().spotify ?? null,
        });

        if (
          session.sourceMode === "players_liked" &&
          (errorMessage === "PLAYERS_LIBRARY_TIMEOUT" || errorMessage === "PLAYERS_LIBRARY_SYNC_TIMEOUT")
        ) {
          if (session.manager.state() === "waiting" && session.poolBuild.status !== "building") {
            this.startPlayersLikedPoolBuild(session);
          }
          return {
            ok: false as const,
            error: "PLAYERS_LIBRARY_SYNCING" as const,
            retryAfterMs: 1_500,
          };
        }

        if (isDeezerPlaylistSource) {
          return {
            ok: false as const,
            error: "PLAYLIST_TRACKS_RESOLVING" as const,
            retryAfterMs: 1_500,
          };
        }

        return {
          ok: false as const,
          error: "NO_TRACKS_FOUND" as const,
        };
      }
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
      session.poolBuild.status = startPoolStats.tracks.length >= poolSize ? "ready" : "failed";
      session.poolBuild.contributorsCount = this.playersLikedContributors(session).length;
      session.poolBuild.mergedTracksCount = startPoolStats.playableTotal;
      session.poolBuild.playableTracksCount = startPoolStats.candidateCount;
      session.poolBuild.lastBuiltAtMs = this.now();
      session.poolBuild.errorCode = startPoolStats.tracks.length >= poolSize ? null : "NO_TRACKS_FOUND";
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

      if (isDeezerPlaylistSource) {
        logEvent("info", "room_start_deezer_playlist_still_resolving", {
          roomCode,
          categoryQuery: resolvedQuery,
          requestedPoolSize: poolSize,
          selectedPoolSize: session.trackPool.length,
          candidatePoolSize: startPoolStats.candidateCount,
          retryAfterMs: 1_500,
        });
        return {
          ok: false as const,
          error: "PLAYLIST_TRACKS_RESOLVING" as const,
          retryAfterMs: 1_500,
        };
      }

      logEvent("warn", "room_start_no_tracks", {
        roomCode,
        categoryQuery: resolvedQuery,
        reason: "EMPTY_POOL",
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
      if (session.roundModes[round - 1] !== "mcq") continue;
      const roundChoices = this.buildRoundChoices(session, round);
      if (roundChoices.length >= MCQ_REQUIRED_CHOICES) continue;
      session.roundModes[round - 1] = "text";
      session.roundChoices.delete(round);
      logEvent("info", "room_start_round_mode_adjusted", {
        roomCode,
        categoryQuery: resolvedQuery,
        round,
        fromMode: "mcq",
        toMode: "text",
        choiceCount: roundChoices.length,
      });
    }
    for (const track of session.trackPool) {
      scheduleRomanizeJapanese(track.title);
      scheduleRomanizeJapanese(track.artist);
    }

    for (const player of session.players.values()) {
      player.score = 0;
      player.lastRoundScore = 0;
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

  submitDraftAnswer(roomCode: string, playerId: string, answer: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };

    const nowMs = this.now();
    this.progressSession(session, nowMs);

    const player = session.players.get(playerId);
    if (!player) return { status: "player_not_found" as const };

    const normalized = answer.trim().slice(0, 120);
    const result = session.manager.setDraftAnswer(playerId, normalized, nowMs);
    return { status: "ok" as const, accepted: result.accepted };
  }

  postChatMessage(roomCode: string, playerId: string, text: string) {
    const session = this.rooms.get(roomCode);
    if (!session) return { status: "room_not_found" as const };
    const player = session.players.get(playerId);
    if (!player) return { status: "player_not_found" as const };

    const normalized = text.trim();
    if (normalized.length <= 0) return { status: "invalid_payload" as const };

    const entry: RoomChatMessage = {
      id: `${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
      playerId: player.id,
      displayName: player.displayName,
      text: normalized.slice(0, 400),
      sentAtMs: this.now(),
    };
    session.chatMessages.push(entry);
    if (session.chatMessages.length > 120) {
      session.chatMessages = session.chatMessages.slice(-120);
    }

    return { status: "ok" as const, message: entry };
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
    if (activeTrack) {
      scheduleRomanizeJapanese(activeTrack.title);
      scheduleRomanizeJapanese(activeTrack.artist);
    }
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
      hasAnsweredCurrentRound: state === "playing" ? session.manager.hasSubmittedAnswer(player.id) : false,
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
    const leaderboard = this.ranking(session)
      .slice(0, 10)
      .map((entry) => ({
        ...entry,
        hasAnsweredCurrentRound: state === "playing" ? session.manager.hasSubmittedAnswer(entry.playerId) : false,
      }));
    if (session.latestReveal) {
      scheduleRomanizeJapanese(session.latestReveal.title);
      scheduleRomanizeJapanese(session.latestReveal.artist);
      const titleRomaji = getRomanizedJapaneseCached(session.latestReveal.title);
      const artistRomaji = getRomanizedJapaneseCached(session.latestReveal.artist);
      if (titleRomaji !== session.latestReveal.titleRomaji) {
        session.latestReveal.titleRomaji = titleRomaji;
      }
      if (artistRomaji !== session.latestReveal.artistRomaji) {
        session.latestReveal.artistRomaji = artistRomaji;
      }
    }

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
            embedUrl: embedUrlForTrack(activeTrack, { roomCode: session.roomCode, round: currentRound }),
          }
        : revealMedia
          ? {
              provider: revealMedia.provider,
              trackId: revealMedia.trackId,
              sourceUrl: revealMedia.sourceUrl,
              embedUrl: revealMedia.embedUrl,
            }
          : null;
    const suggestionTracks =
      session.trackPool.length > 0
        ? [...session.trackPool, ...session.distractorTrackPool]
        : session.playersLikedPool;
    const answerSuggestions = collectRoomAnswerSuggestions(suggestionTracks);

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
      isResolvingTracks: session.isResolvingTracks,
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
        mergedTracksCount: session.poolBuild.mergedTracksCount,
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
      chatMessages: session.chatMessages.slice(-80),
      answerSuggestions,
    };
  }

  async roomAnswerSuggestions(roomCode: string, playerId?: string) {
    const session = this.rooms.get(roomCode);
    if (!session) {
      return { status: "room_not_found" as const };
    }
    if (playerId && !session.players.has(playerId)) {
      return { status: "player_not_found" as const };
    }

    const fallbackTracks =
      session.trackPool.length > 0
        ? [...session.trackPool, ...session.distractorTrackPool]
        : session.playersLikedPool;

    if (session.sourceMode !== "players_liked") {
      return {
        status: "ok" as const,
        suggestions: collectRoomAnswerSuggestions(fallbackTracks, ROOM_ANSWER_SUGGESTION_LIMIT),
      };
    }

    const contributors = this.playersLikedContributors(session);
    const userIds = new Set<string>();
    const providerSet = new Set<LibraryProvider>();
    for (const contributor of contributors) {
      if (contributor.userId) {
        userIds.add(contributor.userId);
      }
      if (this.canUsePlayersLikedProvider(contributor, "spotify")) {
        providerSet.add("spotify");
      }
      if (this.canUsePlayersLikedProvider(contributor, "deezer")) {
        providerSet.add("deezer");
      }
    }

    if (userIds.size <= 0 || providerSet.size <= 0) {
      return {
        status: "ok" as const,
        suggestions: collectRoomAnswerSuggestions(fallbackTracks, ROOM_ANSWER_SUGGESTION_LIMIT),
      };
    }

    const rows = await userLikedTrackRepository.listForUsers({
      userIds: [...userIds],
      providers: [...providerSet],
      limit: ROOM_BULK_ANSWER_TRACK_LIMIT,
      orderBy: "random",
      randomSeed: `${roomCode}:${session.createdAtMs}`,
    });
    const fromLibrary = collectRoomAnswerSuggestions(rows, ROOM_BULK_ANSWER_SUGGESTION_LIMIT);
    if (fromLibrary.length > 0) {
      return { status: "ok" as const, suggestions: fromLibrary };
    }

    return {
      status: "ok" as const,
      suggestions: collectRoomAnswerSuggestions(fallbackTracks, ROOM_ANSWER_SUGGESTION_LIMIT),
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
      sourceMode: RoomSourceMode;
      playlistName: string | null;
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
        sourceMode: session.sourceMode,
        playlistName: session.publicPlaylistSelection?.name ?? null,
        deadlineMs: session.manager.deadlineMs(),
        serverNowMs: nowMs,
      });
    }

    return rooms.sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 50);
  }
}

export const roomStore = new RoomStore();
