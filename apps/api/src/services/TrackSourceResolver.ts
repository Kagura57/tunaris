import { fetchAniListUsersOpeningTracks } from "../routes/music/anilist";
import { fetchDeezerChartTracks, fetchDeezerPlaylistTracks } from "../routes/music/deezer";
import {
  fetchSpotifyPlaylistTracks,
  fetchSpotifyPopularTracks,
  SPOTIFY_RATE_LIMITED_ERROR,
} from "../routes/music/spotify";
import { resolveAnimeThemeVideo } from "../routes/music/animethemes";
import { searchYouTube } from "../routes/music/youtube";
import { logEvent } from "../lib/logger";
import type { MusicTrack } from "./music-types";
import { buildTrackPool } from "./MusicAggregator";
import { resolvedTrackRepository } from "../repositories/ResolvedTrackRepository";

export type ParsedTrackSource =
  | {
      type: "search";
      original: string;
      query: string;
      payload: null;
    }
  | {
      type: "spotify_playlist";
      original: string;
      query: string;
      payload: { playlistId: string };
    }
  | {
      type: "spotify_popular";
      original: string;
      query: string;
      payload: null;
    }
  | {
      type: "deezer_playlist";
      original: string;
      query: string;
      payload: { playlistId: string };
    }
  | {
      type: "deezer_chart";
      original: string;
      query: string;
      payload: null;
    }
  | {
      type: "anilist_users";
      original: string;
      query: string;
      payload: { usernames: string[] };
    };

const SPOTIFY_PLAYLIST_PREFIX = "spotify:playlist:";
const SPOTIFY_POPULAR_PREFIX = "spotify:popular";
const DEEZER_PLAYLIST_PREFIX = "deezer:playlist:";
const DEEZER_CHART_PREFIX = "deezer:chart";
const ANILIST_USERS_PREFIX = "anilist:users:";

function parseUsers(raw: string) {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeSpotifyPlaylistId(raw: string) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  let decoded = safeDecodeURIComponent(trimmed);
  for (let index = 0; index < 4; index += 1) {
    const stripped = decoded.replace(/^spotify:playlist:/i, "").trim();
    if (stripped === decoded) break;
    decoded = stripped;
  }
  const fromUrl = decoded.match(/spotify\.com\/playlist\/([a-zA-Z0-9]+)/i)?.[1];
  if (fromUrl) return fromUrl;
  const fromUri = decoded.match(/spotify:playlist:([a-zA-Z0-9]+)/i)?.[1];
  if (fromUri) return fromUri;
  const normalized = decoded.replace(/[?#].*$/, "").replace(/\/+$/, "").trim();
  const plainId = normalized.match(/([a-zA-Z0-9]{8,})$/)?.[1];
  return plainId ?? normalized;
}

function normalizeDeezerPlaylistId(raw: string) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const decoded = safeDecodeURIComponent(trimmed);
  const fromUrl = decoded.match(/deezer\.com\/(?:[a-z]{2}\/)?playlist\/([0-9]+)/i)?.[1];
  if (fromUrl) return fromUrl;
  return decoded.replace(/[?#].*$/, "").trim();
}

export function parseTrackSource(categoryQuery: string): ParsedTrackSource {
  const trimmed = categoryQuery.trim();
  const lower = trimmed.toLowerCase();

  if (lower.startsWith(SPOTIFY_PLAYLIST_PREFIX)) {
    const playlistId = normalizeSpotifyPlaylistId(trimmed.slice(SPOTIFY_PLAYLIST_PREFIX.length));
    return {
      type: "spotify_playlist",
      original: categoryQuery,
      query: "",
      payload: { playlistId },
    };
  }

  if (lower === SPOTIFY_POPULAR_PREFIX) {
    return {
      type: "spotify_popular",
      original: categoryQuery,
      query: "",
      payload: null,
    };
  }

  if (lower.startsWith(DEEZER_PLAYLIST_PREFIX)) {
    const playlistId = normalizeDeezerPlaylistId(trimmed.slice(DEEZER_PLAYLIST_PREFIX.length));
    return {
      type: "deezer_playlist",
      original: categoryQuery,
      query: "",
      payload: { playlistId },
    };
  }

  if (lower === DEEZER_CHART_PREFIX) {
    return {
      type: "deezer_chart",
      original: categoryQuery,
      query: "",
      payload: null,
    };
  }

  if (lower.startsWith(ANILIST_USERS_PREFIX)) {
    const rawUsers = trimmed.slice(ANILIST_USERS_PREFIX.length);
    const usernames = parseUsers(rawUsers);
    return {
      type: "anilist_users",
      original: categoryQuery,
      query: "",
      payload: { usernames },
    };
  }

  return {
    type: "search",
    original: categoryQuery,
    query: trimmed,
    payload: null,
  };
}

type ResolveTrackPoolOptions = {
  categoryQuery: string;
  size: number;
};

const AD_TRACK_PATTERNS = [
  /\b(advert(?:isement|ising)?|ad\s*break|commercial)\b/i,
  /\b(pub|publicite|annonce|sponsor\w*)\b/i,
  /\bdeezer\s*(ads?|pub|advert)\b/i,
  /\b(this\s+app|download\s+app|free\s+music\s+alternative|best\s+free\s+music)\b/i,
  /\bspotify\b.*\b(app|alternative|free)\b/i,
  /\bheartify\b/i,
  /\bdeezer\s*session\b/i,
  /\ba\s+\w+\s+playlist\b/i,
  /\b(app\s+store|play\s+store|music\s+app)\b/i,
];

function normalizeAdText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyAdTrack(track: Pick<MusicTrack, "title" | "artist">) {
  const text = normalizeAdText(`${track.title} ${track.artist}`);
  return AD_TRACK_PATTERNS.some((pattern) => pattern.test(text));
}

function sanitizeTrackSearchValue(value: string) {
  return value
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(feat|featuring|ft)\.?[^-]*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type YouTubeSearchIntent = "official_clip" | "official_audio" | "fallback";

type YouTubeQueryPlanStep = {
  intent: YouTubeSearchIntent;
  queries: string[];
};

function uniqueQueries(values: string[]) {
  return Array.from(
    new Set(
      values
        .map((value) => value.replace(/\s+/g, " ").trim())
        .filter((value) => value.length > 0),
    ),
  );
}

function buildYouTubeQueryPlan(track: Pick<MusicTrack, "title" | "artist">): YouTubeQueryPlanStep[] {
  const title = track.title.trim();
  const artist = track.artist.trim();
  const sanitizedTitle = sanitizeTrackSearchValue(title);
  const fallbackTitle = sanitizedTitle.length > 0 ? sanitizedTitle : title;

  return [
    {
      intent: "official_clip",
      queries: uniqueQueries([
        `${artist} ${title} official video`,
        `${artist} ${title} official clip`,
        `${artist} ${title} music video`,
        `${artist} ${fallbackTitle} official video`,
      ]),
    },
    {
      intent: "official_audio",
      queries: uniqueQueries([`${artist} ${title} official audio`, `${artist} ${fallbackTitle} official audio`]),
    },
    {
      intent: "fallback",
      queries: uniqueQueries([`${artist} ${title}`, `${artist} ${fallbackTitle}`]),
    },
  ].filter((step) => step.queries.length > 0);
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

function nonEmptySlice(tracks: MusicTrack[], size: number) {
  const safeSize = Math.max(1, size);
  const sanitized = tracks.filter((track) => !isLikelyAdTrack(track));
  const shuffled = randomShuffle(sanitized);
  const withPreview = shuffled.filter((track) => Boolean(track.previewUrl));
  const withoutPreview = shuffled.filter((track) => !track.previewUrl);
  return [...withPreview, ...withoutPreview].slice(0, safeSize);
}

type YouTubeTrackCacheEntry = {
  track: MusicTrack;
  expiresAt: number;
};

const youtubeTrackCache = new Map<string, YouTubeTrackCacheEntry>();
const YOUTUBE_TRACK_CACHE_TTL_MS = 24 * 60 * 60_000;
const YOUTUBE_RESOLVE_BUDGET_MAX = 48;
const YOUTUBE_RESOLVE_BUDGET_MIN = 1;
const YOUTUBE_RESOLVE_BATCH_SIZE = 5;

function signature(track: Pick<MusicTrack, "title" | "artist">) {
  return `${track.title.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`;
}

function isYouTubeLikeTrack(track: Pick<MusicTrack, "provider" | "sourceUrl">) {
  if (track.provider === "youtube") return true;
  const source = track.sourceUrl?.toLowerCase() ?? "";
  return source.includes("youtube.com/watch") || source.includes("youtu.be/");
}

function dedupeTracks(tracks: MusicTrack[], size: number) {
  const seen = new Set<string>();
  const result: MusicTrack[] = [];

  for (const track of tracks) {
    if (result.length >= size) break;
    const key = `${track.id.toLowerCase()}::${signature(track)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(track);
  }

  return result;
}

async function searchPlayableYouTube(query: string, limit: number): Promise<MusicTrack[]> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const youtube = await searchYouTube(query, safeLimit);
  return dedupeTracks(youtube, safeLimit);
}

const YOUTUBE_CLIP_PATTERNS = [
  /\bofficial\s+(music\s+)?video\b/i,
  /\bofficial\s+clip\b/i,
  /\bmusic\s+video\b/i,
  /\bofficial\s+mv\b/i,
  /\bmv\b/i,
];

const YOUTUBE_AUDIO_PATTERNS = [/\bofficial\s+audio\b/i, /\baudio\b/i, /\btopic\b/i];

const YOUTUBE_DEPRIORITY_PATTERNS = [
  /\blyrics?\b/i,
  /\breaction\b/i,
  /\blive\b/i,
  /\bcover\b/i,
  /\bkaraoke\b/i,
  /\bnightcore\b/i,
  /\bslowed\b/i,
  /\bsped\s*up\b/i,
  /\bshorts?\b/i,
  /\bvlog\b/i,
  /\bteaser\b/i,
  /\btrailer\b/i,
  /\binterview\b/i,
  /\bbehind\s+the\s+scenes\b/i,
  /\b(tour|travel)\s+diary\b/i,
];

function normalizeSearchText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ARTIST_CHANNEL_STOP_WORDS = new Set([
  "official",
  "music",
  "records",
  "recordings",
  "recording",
  "entertainment",
  "vevo",
  "topic",
  "channel",
  "tv",
  "videos",
  "video",
]);

function normalizeCompact(value: string) {
  return normalizeSearchText(value).replace(/\s+/g, "");
}

function isArtistChannel(candidateChannelTitle: string, sourceArtist: string) {
  const channel = normalizeSearchText(candidateChannelTitle);
  const artist = normalizeSearchText(sourceArtist);
  if (channel.length <= 0 || artist.length <= 0) return false;
  if (channel.includes(artist)) return true;

  const compactChannel = normalizeCompact(candidateChannelTitle);
  const compactArtist = normalizeCompact(sourceArtist);
  if (compactChannel.length > 0 && compactArtist.length > 0 && compactChannel.includes(compactArtist)) {
    return true;
  }

  const sourceTokens = artist
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !ARTIST_CHANNEL_STOP_WORDS.has(token));
  const channelTokens = new Set(
    channel
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length > 1 && !ARTIST_CHANNEL_STOP_WORDS.has(token)),
  );
  if (sourceTokens.length <= 0 || channelTokens.size <= 0) return false;

  let matches = 0;
  for (const token of sourceTokens) {
    if (channelTokens.has(token)) matches += 1;
  }
  if (sourceTokens.length === 1) return matches === 1;
  return matches >= sourceTokens.length - 1;
}

type ScoredYouTubeCandidate = {
  score: number;
  isClip: boolean;
  isAudio: boolean;
  artistChannel: boolean;
  artistMatched: boolean;
  titleTokenOverlap: number;
  titleTokenCount: number;
  offVersionMismatch: boolean;
};

const TITLE_TOKEN_STOP_WORDS = new Set([
  "official",
  "video",
  "clip",
  "music",
  "audio",
  "mv",
  "topic",
  "version",
  "feat",
  "featuring",
  "ft",
  "the",
  "and",
  "with",
  "from",
  "for",
  "live",
  "lyrics",
]);

function titleTokens(value: string) {
  return normalizeSearchText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => {
      if (token.length <= 0 || TITLE_TOKEN_STOP_WORDS.has(token)) return false;
      if (token.length >= 3) return true;
      return /[^\x00-\x7f]/.test(token);
    });
}

function scoreYouTubeCandidate(
  candidate: Pick<MusicTrack, "title" | "artist">,
  source: Pick<MusicTrack, "title" | "artist">,
): ScoredYouTubeCandidate {
  const candidateText = normalizeSearchText(`${candidate.title} ${candidate.artist}`);
  const candidateTitleText = normalizeSearchText(candidate.title);
  const sourceArtist = normalizeSearchText(source.artist);
  const sourceTitle = normalizeSearchText(sanitizeTrackSearchValue(source.title));
  const sourceRawTitle = normalizeSearchText(source.title);
  const sourceTitleTokens = titleTokens(sourceTitle);
  const candidateTitleTokens = new Set(titleTokens(candidateTitleText));
  const candidateTitleTokenCount = candidateTitleTokens.size;
  const artistChannel = isArtistChannel(candidate.artist, source.artist);
  const artistMatched = sourceArtist.length <= 0 || candidateText.includes(sourceArtist) || artistChannel;
  const isClip = YOUTUBE_CLIP_PATTERNS.some((pattern) => pattern.test(candidateTitleText));
  const isAudio =
    YOUTUBE_AUDIO_PATTERNS.some((pattern) => pattern.test(candidateTitleText)) ||
    (sourceTitle.length > 0 &&
      candidateTitleText.includes(sourceTitle) &&
      normalizeSearchText(candidate.artist).includes("topic"));
  const offVersionMismatch =
    (/\blive\b/i.test(candidateTitleText) && !/\blive\b/i.test(sourceRawTitle)) ||
    (/\bcover\b/i.test(candidateTitleText) && !/\bcover\b/i.test(sourceRawTitle)) ||
    (/\bkaraoke\b/i.test(candidateTitleText) && !/\bkaraoke\b/i.test(sourceRawTitle)) ||
    (/\breaction\b/i.test(candidateTitleText) && !/\breaction\b/i.test(sourceRawTitle)) ||
    (/\bnightcore\b/i.test(candidateTitleText) && !/\bnightcore\b/i.test(sourceRawTitle)) ||
    (/\bslowed\b/i.test(candidateTitleText) && !/\bslowed\b/i.test(sourceRawTitle)) ||
    (/\bsped\s*up\b/i.test(candidateTitleText) && !/\bsped\s*up\b/i.test(sourceRawTitle)) ||
    (/\bshort\s*(ver|version)\b/i.test(candidateTitleText) &&
      !/\bshort\s*(ver|version)\b/i.test(sourceRawTitle)) ||
    (/\btv\s*size\b/i.test(candidateTitleText) && !/\btv\s*size\b/i.test(sourceRawTitle));

  let score = 0;
  let titleTokenOverlap = 0;
  for (const token of sourceTitleTokens) {
    if (candidateTitleTokens.has(token)) titleTokenOverlap += 1;
  }

  if (sourceArtist.length > 0 && candidateText.includes(sourceArtist)) score += 80;
  if (sourceTitle.length > 0 && candidateText.includes(sourceTitle)) score += 90;
  if (sourceTitleTokens.length > 0) {
    if (titleTokenOverlap <= 0) {
      score -= 320;
    } else {
      score += 55 * titleTokenOverlap;
      score += Math.round((titleTokenOverlap / sourceTitleTokens.length) * 90);
      if (candidateTitleTokenCount > 0) {
        score += Math.round((titleTokenOverlap / candidateTitleTokenCount) * 120);
      }
      const extraTitleTokens = Math.max(0, candidateTitleTokenCount - titleTokenOverlap);
      if (extraTitleTokens > 0) {
        score -= extraTitleTokens * 35;
      }
    }
  }
  if (artistChannel) score += 260;
  if (isClip) score += 240;
  if (isAudio) score += 130;
  if (artistChannel && isClip) score += 220;
  if (artistChannel && isAudio) score += 120;
  if (sourceArtist.length > 0 && !artistMatched) score -= 220;
  if (offVersionMismatch) score -= 450;
  for (const pattern of YOUTUBE_DEPRIORITY_PATTERNS) {
    if (pattern.test(candidateText)) score -= 120;
  }

  return {
    score,
    isClip,
    isAudio,
    artistChannel,
    artistMatched,
    titleTokenOverlap,
    titleTokenCount: sourceTitleTokens.length,
    offVersionMismatch,
  };
}

type RankedYouTubeCandidate = {
  track: MusicTrack;
  score: number;
  artistChannel: boolean;
};

function selectRankedYouTubeCandidate(
  candidates: MusicTrack[],
  source: Pick<MusicTrack, "title" | "artist">,
  intent: YouTubeSearchIntent,
): RankedYouTubeCandidate | null {
  const ranked = candidates
    .map((track) => ({ track, scored: scoreYouTubeCandidate(track, source) }))
    .filter(({ scored }) => Number.isFinite(scored.score));

  let scoped = ranked;
  if (intent === "official_clip") {
    scoped = ranked.filter(
      ({ scored }) =>
        scored.isClip &&
        !scored.offVersionMismatch &&
        (scored.titleTokenCount <= 0 || scored.titleTokenOverlap > 0),
    );
  } else if (intent === "official_audio") {
    scoped = ranked.filter(
      ({ scored }) =>
        scored.isAudio &&
        !scored.isClip &&
        !scored.offVersionMismatch &&
        (scored.titleTokenCount <= 0 || scored.titleTokenOverlap > 0),
    );
  } else {
    const base = ranked.filter(({ scored }) => scored.titleTokenCount <= 0 || scored.titleTokenOverlap > 0);
    const nonMismatch = base.filter(({ scored }) => !scored.offVersionMismatch);
    scoped = nonMismatch.length > 0 ? nonMismatch : base;
  }
  const artistMatchedOnly = scoped.filter(({ scored }) => scored.artistMatched);
  if (artistMatchedOnly.length > 0) {
    scoped = artistMatchedOnly;
  }
  if (scoped.length <= 0) return null;

  scoped.sort((left, right) => right.scored.score - left.scored.score);
  const winner = scoped[0];
  if (!winner) return null;

  return {
    track: winner.track,
    score: winner.scored.score,
    artistChannel: winner.scored.artistChannel,
  };
}

type YouTubePlaybackResolution = {
  track: MusicTrack | null;
  attemptedQueries: number;
  failedQueries: number;
  emptyResultQueries: number;
  fromCache: boolean;
  fromPersistentCache: boolean;
  alreadyYouTube: boolean;
  selectedQuery: string | null;
  lastError: string | null;
};

function durationMsToSec(durationMs: number | null | undefined) {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return null;
  return Math.max(0, Math.floor(durationMs / 1000));
}

function secToDurationMs(durationSec: number | null | undefined) {
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec)) return null;
  return Math.max(0, Math.round(durationSec * 1000));
}

async function resolveYouTubePlayback(track: MusicTrack): Promise<YouTubePlaybackResolution> {
  if (isYouTubeLikeTrack(track)) {
    return {
      track: {
        ...track,
        provider: "youtube",
        sourceUrl: track.sourceUrl ?? `https://www.youtube.com/watch?v=${track.id}`,
        previewUrl: null,
      } satisfies MusicTrack,
      attemptedQueries: 0,
      failedQueries: 0,
      emptyResultQueries: 0,
      fromCache: false,
      fromPersistentCache: false,
      alreadyYouTube: true,
      selectedQuery: null,
      lastError: null,
    };
  }

  const key = signature(track);
  const cached = youtubeTrackCache.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return {
        track: cached.track,
        attemptedQueries: 0,
        failedQueries: 0,
        emptyResultQueries: 0,
        fromCache: true,
        fromPersistentCache: false,
        alreadyYouTube: false,
        selectedQuery: null,
        lastError: null,
      };
    }
    youtubeTrackCache.delete(key);
  }

  let persisted: Awaited<ReturnType<typeof resolvedTrackRepository.getBySource>> = null;
  try {
    persisted = await resolvedTrackRepository.getBySource(track.provider, track.id);
  } catch (error) {
    logEvent("warn", "resolved_track_cache_lookup_failed", {
      provider: track.provider,
      sourceTrackId: track.id,
      title: track.title,
      artist: track.artist,
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
    });
  }
  if (persisted?.youtubeVideoId) {
    const cachedResolved = {
      provider: "youtube" as const,
      id: persisted.youtubeVideoId,
      title: track.title,
      artist: track.artist,
      durationSec: track.durationSec ?? durationMsToSec(persisted.durationMs),
      previewUrl: null,
      sourceUrl: `https://www.youtube.com/watch?v=${persisted.youtubeVideoId}`,
    } satisfies MusicTrack;
    youtubeTrackCache.set(key, {
      track: cachedResolved,
      expiresAt: Date.now() + YOUTUBE_TRACK_CACHE_TTL_MS,
    });
    return {
      track: cachedResolved,
      attemptedQueries: 0,
      failedQueries: 0,
      emptyResultQueries: 0,
      fromCache: false,
      fromPersistentCache: true,
      alreadyYouTube: false,
      selectedQuery: null,
      lastError: null,
    };
  }

  const queryPlan = buildYouTubeQueryPlan(track);
  let attemptedQueries = 0;
  let failedQueries = 0;
  let emptyResultQueries = 0;
  let lastError: string | null = null;
  for (const step of queryPlan) {
    let best: RankedYouTubeCandidate | null = null;
    let selectedQuery: string | null = null;

    for (const searchQuery of step.queries) {
      attemptedQueries += 1;
      let candidates: MusicTrack[] = [];
      try {
        candidates = await searchPlayableYouTube(searchQuery, 5);
      } catch (error) {
        failedQueries += 1;
        lastError = error instanceof Error ? error.message : "UNKNOWN_ERROR";
        logEvent("warn", "track_source_youtube_query_failed", {
          query: searchQuery,
          title: track.title,
          artist: track.artist,
          error: lastError,
        });
        continue;
      }

      const selected = selectRankedYouTubeCandidate(candidates, track, step.intent);
      if (!selected) {
        emptyResultQueries += 1;
        continue;
      }

      if (!best || selected.score > best.score) {
        best = selected;
        selectedQuery = searchQuery;
      }
      if (selected.artistChannel) break;
    }
    if (!best) continue;

    const resolved = {
      provider: "youtube" as const,
      id: best.track.id,
      title: track.title,
      artist: track.artist,
      // Prefer resolved YouTube duration; fallback to source duration when unavailable so
      // round start can still be randomized instead of always starting at 0.
      durationSec: best.track.durationSec ?? track.durationSec ?? null,
      previewUrl: null,
      sourceUrl: best.track.sourceUrl ?? `https://www.youtube.com/watch?v=${best.track.id}`,
    } satisfies MusicTrack;

    try {
      await resolvedTrackRepository.upsert({
        provider: track.provider,
        sourceId: track.id,
        title: track.title,
        artist: track.artist,
        youtubeVideoId: best.track.id,
        durationMs: secToDurationMs(resolved.durationSec),
      });
    } catch (error) {
      logEvent("warn", "resolved_track_cache_upsert_failed", {
        provider: track.provider,
        sourceTrackId: track.id,
        title: track.title,
        artist: track.artist,
        youtubeVideoId: best.track.id,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      });
    }

    youtubeTrackCache.set(key, {
      track: resolved,
      expiresAt: Date.now() + YOUTUBE_TRACK_CACHE_TTL_MS,
    });
    return {
      track: resolved,
      attemptedQueries,
      failedQueries,
      emptyResultQueries,
      fromCache: false,
      fromPersistentCache: false,
      alreadyYouTube: false,
      selectedQuery,
      lastError,
    };
  }

  return {
    track: null,
    attemptedQueries,
    failedQueries,
    emptyResultQueries,
    fromCache: false,
    fromPersistentCache: false,
    alreadyYouTube: false,
    selectedQuery: null,
    lastError,
  };
}

async function prioritizeYouTubePlayback(
  tracks: MusicTrack[],
  size: number,
  input: { fillQuery: string; allowQueryFill: boolean; maxResolveBudget?: number },
) {
  const safeSize = Math.max(1, size);
  const scoped = nonEmptySlice(tracks, Math.max(tracks.length, safeSize));
  const result: MusicTrack[] = [];
  const seen = new Set<string>();
  let youtubeResolved = 0;
  let queryResolved = 0;
  let directResolveAttempts = 0;
  let directResolveNoMatch = 0;
  let directResolveFromCache = 0;
  let directResolveFromPersistentCache = 0;
  let directResolveAlreadyYouTube = 0;
  let directResolveSearchQueryAttempts = 0;
  let directResolveSearchFailures = 0;
  let directResolveSearchEmptyResults = 0;
  const directResolveErrorSamples = new Set<string>();
  let directResolveBatchCount = 0;
  let queryFillAttempts = 0;
  let queryFillFailures = 0;
  let queryFillCandidateCount = 0;

  const remaining = Math.max(0, safeSize - result.length);
  const computedBudget = Math.min(
    scoped.length,
    Math.max(
      YOUTUBE_RESOLVE_BUDGET_MIN,
      Math.min(YOUTUBE_RESOLVE_BUDGET_MAX, Math.max(safeSize * 2, remaining * 4)),
    ),
  );
  const resolveBudget =
    typeof input.maxResolveBudget === "number"
      ? Math.min(scoped.length, Math.max(YOUTUBE_RESOLVE_BUDGET_MIN, Math.floor(input.maxResolveBudget)))
      : computedBudget;
  const candidates = scoped.slice(0, resolveBudget);
  for (
    let batchStart = 0;
    batchStart < candidates.length && result.length < safeSize;
    batchStart += YOUTUBE_RESOLVE_BATCH_SIZE
  ) {
    const batch = candidates.slice(batchStart, batchStart + YOUTUBE_RESOLVE_BATCH_SIZE);
    const uniqueBatch: MusicTrack[] = [];
    for (const track of batch) {
      const key = signature(track);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueBatch.push(track);
    }
    if (uniqueBatch.length <= 0) continue;
    directResolveBatchCount += 1;

    const batchResults = await Promise.all(
      uniqueBatch.map(async (track) => {
        directResolveAttempts += 1;
        try {
          const resolution = await resolveYouTubePlayback(track);
          return { track, resolution };
        } catch (error) {
          logEvent("warn", "track_source_direct_resolve_failed", {
            title: track.title,
            artist: track.artist,
            error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
          });
          return { track, resolution: null as YouTubePlaybackResolution | null };
        }
      }),
    );

    for (const item of batchResults) {
      if (result.length >= safeSize) break;
      const { track, resolution } = item;
      if (!resolution) continue;

      directResolveSearchQueryAttempts += resolution.attemptedQueries;
      directResolveSearchFailures += resolution.failedQueries;
      directResolveSearchEmptyResults += resolution.emptyResultQueries;
      if (resolution.fromCache) directResolveFromCache += 1;
      if (resolution.fromPersistentCache) directResolveFromPersistentCache += 1;
      if (resolution.alreadyYouTube) directResolveAlreadyYouTube += 1;
      if (resolution.lastError && directResolveErrorSamples.size < 5) {
        directResolveErrorSamples.add(resolution.lastError);
      }

      if (resolution.track) {
        youtubeResolved += 1;
        result.push(resolution.track);
      } else {
        directResolveNoMatch += 1;
        logEvent("debug", "track_source_youtube_track_skipped", {
          title: track.title,
          artist: track.artist,
          reason: "NO_YOUTUBE_MATCH",
          attemptedQueries: resolution.attemptedQueries,
          failedQueries: resolution.failedQueries,
          emptyResultQueries: resolution.emptyResultQueries,
          lastError: resolution.lastError,
        });
      }
    }
  }

  if (input.allowQueryFill && result.length < safeSize && input.fillQuery.trim().length > 0) {
    const fillQueries = Array.from(
      new Set(
        [input.fillQuery, `${input.fillQuery} official video`, `${input.fillQuery} official mv`]
          .map((query) => query.trim())
          .filter((query) => query.length > 0),
      ),
    );
    for (const query of fillQueries) {
      if (result.length >= safeSize) break;
      queryFillAttempts += 1;
      let candidates: MusicTrack[] = [];
      try {
        candidates = await searchPlayableYouTube(query, Math.min(10, safeSize));
      } catch (error) {
        queryFillFailures += 1;
        logEvent("warn", "track_source_query_fill_failed", {
          query,
          error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
        });
        continue;
      }
      queryFillCandidateCount += candidates.length;
      for (const track of candidates) {
        if (result.length >= safeSize) break;
        if (isLikelyAdTrack(track)) continue;
        const key = signature(track);
        if (seen.has(key)) continue;
        seen.add(key);
        queryResolved += 1;
        result.push(track);
      }
    }
  }

  logEvent("info", "track_source_youtube_priority", {
    requestedSize: safeSize,
    inputCount: tracks.length,
    outputCount: result.length,
    youtubeResolved,
    queryResolved,
    directResolveAttempts,
    directResolveNoMatch,
    directResolveFromCache,
    directResolveFromPersistentCache,
    directResolveAlreadyYouTube,
    directResolveBatchCount,
    directResolveBatchSize: YOUTUBE_RESOLVE_BATCH_SIZE,
    directResolveSearchQueryAttempts,
    directResolveSearchFailures,
    directResolveSearchEmptyResults,
    directResolveErrorSamples: [...directResolveErrorSamples],
    queryFillAttempts,
    queryFillFailures,
    queryFillCandidateCount,
    resolveBudget,
    droppedNonYoutubeCount: Math.max(0, tracks.length - youtubeResolved),
  });

  if (result.length <= 0) {
    logEvent("warn", "track_source_youtube_priority_empty", {
      requestedSize: safeSize,
      inputCount: tracks.length,
      directResolveAttempts,
      directResolveNoMatch,
      directResolveFromCache,
      directResolveFromPersistentCache,
      directResolveAlreadyYouTube,
      directResolveBatchCount,
      directResolveBatchSize: YOUTUBE_RESOLVE_BATCH_SIZE,
      directResolveSearchQueryAttempts,
      directResolveSearchFailures,
      directResolveSearchEmptyResults,
      directResolveErrorSamples: [...directResolveErrorSamples],
      queryFillAttempts,
      queryFillFailures,
      queryFillCandidateCount,
      fillQuery: input.fillQuery,
    });
  }

  return result.slice(0, safeSize);
}

export async function resolveTracksToPlayableYouTube(
  tracks: MusicTrack[],
  size: number,
  fillQuery = "",
) {
  const constrainedResolveBudget = Math.max(
    YOUTUBE_RESOLVE_BUDGET_MIN,
    Math.floor(Math.max(1, size)),
  );
  return prioritizeYouTubePlayback(tracks, size, {
    fillQuery,
    allowQueryFill: fillQuery.trim().length > 0,
    maxResolveBudget: constrainedResolveBudget,
  });
}

function fillQueryForParsedSource(parsed: ParsedTrackSource) {
  if (parsed.type === "search") return parsed.query;
  return "";
}

async function prioritizeAnimeThemesPlayback(tracks: MusicTrack[], size: number) {
  const safeSize = Math.max(1, size);
  const animeTracks = tracks.filter((track) => track.answer?.mode === "anime");
  if (animeTracks.length <= 0) return [];

  const selected: MusicTrack[] = [];
  const seenAnswers = new Set<string>();
  for (const track of animeTracks) {
    if (selected.length >= safeSize) break;
    const canonical = track.answer?.canonical?.trim() ?? "";
    if (!canonical) continue;
    const answerKey = canonical.toLowerCase();
    if (seenAnswers.has(answerKey)) continue;
    seenAnswers.add(answerKey);

    const resolved = await resolveAnimeThemeVideo({
      canonicalTitle: canonical,
      aliases: track.answer?.aliases ?? [],
    });
    if (!resolved) continue;

    selected.push({
      ...track,
      provider: "animethemes",
      id: resolved.trackId,
      title: canonical,
      artist: resolved.themeLabel || "Anime Theme",
      durationSec: track.durationSec ?? null,
      previewUrl: null,
      sourceUrl: resolved.sourceUrl,
    } satisfies MusicTrack);
  }

  return selected.slice(0, safeSize);
}

function sourceFetchLimit(size: number) {
  return Math.min(120, Math.max(24, size * 2));
}

export async function resolveTrackPoolFromSource(
  options: ResolveTrackPoolOptions,
): Promise<MusicTrack[]> {
  const safeSize = Math.max(1, Math.min(options.size, 100));
  const parsed = parseTrackSource(options.categoryQuery);

  try {
    if (parsed.type === "spotify_playlist" && parsed.payload) {
      const tracks = await fetchSpotifyPlaylistTracks(
        parsed.payload.playlistId,
        sourceFetchLimit(safeSize),
        {
          enrichPreview: false,
        },
      );
      if (tracks.length > 0) {
        const prioritized = await prioritizeYouTubePlayback(
          tracks,
          safeSize,
          {
            fillQuery: fillQueryForParsedSource(parsed),
            allowQueryFill: parsed.type === "search",
            maxResolveBudget: tracks.length,
          },
        );
        if (prioritized.length > 0) return prioritized;
        logEvent("warn", "track_source_priority_empty_fallback", {
          sourceType: parsed.type,
          categoryQuery: options.categoryQuery,
          requestedSize: safeSize,
          inputCount: tracks.length,
        });
      }
      logEvent("warn", "track_source_empty_fallback", {
        sourceType: parsed.type,
        categoryQuery: options.categoryQuery,
        requestedSize: safeSize,
      });
      return [];
    }

    if (parsed.type === "spotify_popular") {
      const tracks = await fetchSpotifyPopularTracks(Math.min(50, Math.max(safeSize * 3, safeSize)), {
        enrichPreview: false,
      });
      if (tracks.length > 0) {
        const prioritized = await prioritizeYouTubePlayback(
          tracks,
          safeSize,
          {
            fillQuery: fillQueryForParsedSource(parsed),
            allowQueryFill: parsed.type === "search",
            maxResolveBudget: tracks.length,
          },
        );
        if (prioritized.length > 0) return prioritized;
        logEvent("warn", "track_source_priority_empty_fallback", {
          sourceType: parsed.type,
          categoryQuery: options.categoryQuery,
          requestedSize: safeSize,
          inputCount: tracks.length,
        });
      }
      logEvent("warn", "track_source_empty_fallback", {
        sourceType: parsed.type,
        categoryQuery: options.categoryQuery,
        requestedSize: safeSize,
      });
      return [];
    }

    if (parsed.type === "deezer_playlist" && parsed.payload) {
      const tracks = await fetchDeezerPlaylistTracks(parsed.payload.playlistId, sourceFetchLimit(safeSize));
      if (tracks.length > 0) {
        const prioritized = await prioritizeYouTubePlayback(
          tracks,
          safeSize,
          {
            fillQuery: fillQueryForParsedSource(parsed),
            allowQueryFill: parsed.type === "search",
            maxResolveBudget: tracks.length,
          },
        );
        if (prioritized.length > 0) return prioritized;
        logEvent("warn", "track_source_priority_empty_fallback", {
          sourceType: parsed.type,
          categoryQuery: options.categoryQuery,
          requestedSize: safeSize,
          inputCount: tracks.length,
        });
      }
      logEvent("warn", "track_source_empty_fallback", {
        sourceType: parsed.type,
        categoryQuery: options.categoryQuery,
        requestedSize: safeSize,
      });
      return [];
    }

    if (parsed.type === "deezer_chart") {
      const tracks = await fetchDeezerChartTracks(Math.min(50, Math.max(safeSize * 3, safeSize)));
      if (tracks.length > 0) {
        const prioritized = await prioritizeYouTubePlayback(
          tracks,
          safeSize,
          {
            fillQuery: fillQueryForParsedSource(parsed),
            allowQueryFill: parsed.type === "search",
            maxResolveBudget: tracks.length,
          },
        );
        if (prioritized.length > 0) return prioritized;
        logEvent("warn", "track_source_priority_empty_fallback", {
          sourceType: parsed.type,
          categoryQuery: options.categoryQuery,
          requestedSize: safeSize,
          inputCount: tracks.length,
        });
      }
      logEvent("warn", "track_source_empty_fallback", {
        sourceType: parsed.type,
        categoryQuery: options.categoryQuery,
        requestedSize: safeSize,
      });
      return [];
    }

    if (parsed.type === "anilist_users" && parsed.payload) {
      const tracks = await fetchAniListUsersOpeningTracks(
        parsed.payload.usernames,
        Math.min(50, Math.max(safeSize * 3, safeSize)),
      );
      if (tracks.length > 0) {
        const animeThemesFirst = await prioritizeAnimeThemesPlayback(tracks, safeSize);
        if (animeThemesFirst.length >= safeSize) {
          return animeThemesFirst.slice(0, safeSize);
        }

        const prioritizedYouTube = await prioritizeYouTubePlayback(
          tracks,
          safeSize,
          {
            fillQuery: fillQueryForParsedSource(parsed),
            allowQueryFill: parsed.type === "search",
            maxResolveBudget: tracks.length,
          },
        );
        if (animeThemesFirst.length > 0 && prioritizedYouTube.length > 0) {
          const merged: MusicTrack[] = [];
          const seen = new Set<string>();
          for (const track of [...animeThemesFirst, ...prioritizedYouTube]) {
            const answerKey = track.answer?.canonical?.toLowerCase() ?? `${track.provider}:${track.id}`;
            if (seen.has(answerKey)) continue;
            seen.add(answerKey);
            merged.push(track);
            if (merged.length >= safeSize) break;
          }
          if (merged.length > 0) return merged;
        }
        if (animeThemesFirst.length > 0) return animeThemesFirst;
        if (prioritizedYouTube.length > 0) return prioritizedYouTube;
        logEvent("warn", "track_source_priority_empty_fallback", {
          sourceType: parsed.type,
          categoryQuery: options.categoryQuery,
          requestedSize: safeSize,
          inputCount: tracks.length,
        });
      }
      logEvent("warn", "track_source_empty_fallback", {
        sourceType: parsed.type,
        categoryQuery: options.categoryQuery,
        requestedSize: safeSize,
      });
      return [];
    }

    const fallbackTracks = await buildTrackPool(parsed.query, safeSize);
    return prioritizeYouTubePlayback(fallbackTracks, safeSize, {
      fillQuery: fillQueryForParsedSource(parsed),
      allowQueryFill: parsed.type === "search",
    });
  } catch (error) {
    if (error instanceof Error && error.message === SPOTIFY_RATE_LIMITED_ERROR) {
      throw error;
    }

    logEvent("warn", "track_source_resolution_failed", {
      sourceType: parsed.type,
      categoryQuery: options.categoryQuery,
      requestedSize: safeSize,
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
    });

    if (parsed.type !== "search") {
      return [];
    }

    const fallbackTracks = await buildTrackPool(parsed.query, safeSize);
    return prioritizeYouTubePlayback(fallbackTracks, safeSize, {
      fillQuery: fillQueryForParsedSource(parsed),
      allowQueryFill: true,
    });
  }
}
