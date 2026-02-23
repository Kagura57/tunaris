import { fetchAniListUsersOpeningTracks } from "../routes/music/anilist";
import { fetchDeezerChartTracks, fetchDeezerPlaylistTracks } from "../routes/music/deezer";
import {
  fetchSpotifyPlaylistTracks,
  fetchSpotifyPopularTracks,
  SPOTIFY_RATE_LIMITED_ERROR,
} from "../routes/music/spotify";
import { searchYouTube } from "../routes/music/youtube";
import { logEvent } from "../lib/logger";
import type { MusicTrack } from "./music-types";
import { buildTrackPool } from "./MusicAggregator";

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

function buildYouTubeQueryVariants(track: Pick<MusicTrack, "title" | "artist">) {
  const title = track.title.trim();
  const artist = track.artist.trim();
  const sanitizedTitle = sanitizeTrackSearchValue(title);

  return Array.from(
    new Set(
      [
        `${artist} - ${title}`,
        `${artist} - ${sanitizedTitle}`,
        `${artist} ${title}`,
      ]
        .map((query) => query.replace(/\s+/g, " ").trim())
        .filter((query) => query.length > 0),
    ),
  );
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
const YOUTUBE_RESOLVE_CONCURRENCY = 4;

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

type YouTubePlaybackResolution = {
  track: MusicTrack | null;
  attemptedQueries: number;
  failedQueries: number;
  emptyResultQueries: number;
  fromCache: boolean;
  alreadyYouTube: boolean;
  selectedQuery: string | null;
  lastError: string | null;
};

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
        alreadyYouTube: false,
        selectedQuery: null,
        lastError: null,
      };
    }
    youtubeTrackCache.delete(key);
  }

  const queryVariants = buildYouTubeQueryVariants(track);
  let attemptedQueries = 0;
  let failedQueries = 0;
  let emptyResultQueries = 0;
  let lastError: string | null = null;
  for (const searchQuery of queryVariants) {
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

    const selected = candidates[0] ?? null;
    if (!selected) {
      emptyResultQueries += 1;
      continue;
    }

    const resolved = {
      provider: "youtube" as const,
      id: selected.id,
      title: track.title,
      artist: track.artist,
      durationSec: track.durationSec ?? null,
      previewUrl: null,
      sourceUrl: selected.sourceUrl ?? `https://www.youtube.com/watch?v=${selected.id}`,
    } satisfies MusicTrack;

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
      alreadyYouTube: false,
      selectedQuery: searchQuery,
      lastError,
    };
  }

  return {
    track: null,
    attemptedQueries,
    failedQueries,
    emptyResultQueries,
    fromCache: false,
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
  let directResolveAlreadyYouTube = 0;
  let directResolveSearchQueryAttempts = 0;
  let directResolveSearchFailures = 0;
  let directResolveSearchEmptyResults = 0;
  const directResolveErrorSamples = new Set<string>();
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
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(YOUTUBE_RESOLVE_CONCURRENCY, candidates.length) }, async () => {
      while (result.length < safeSize) {
        const index = cursor;
        cursor += 1;
        const track = candidates[index];
        if (!track) break;
        const key = signature(track);
        if (seen.has(key)) continue;
        seen.add(key);

        directResolveAttempts += 1;
        let resolution: YouTubePlaybackResolution | null = null;
        try {
          resolution = await resolveYouTubePlayback(track);
        } catch (error) {
          logEvent("warn", "track_source_direct_resolve_failed", {
            title: track.title,
            artist: track.artist,
            error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
          });
          continue;
        }

        if (!resolution) continue;

        directResolveSearchQueryAttempts += resolution.attemptedQueries;
        directResolveSearchFailures += resolution.failedQueries;
        directResolveSearchEmptyResults += resolution.emptyResultQueries;
        if (resolution.fromCache) directResolveFromCache += 1;
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
    }),
  );

  if (input.allowQueryFill && result.length < safeSize && input.fillQuery.trim().length > 0) {
    const fillQueries = Array.from(
      new Set(
        [input.fillQuery, `${input.fillQuery} official audio`]
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
    directResolveAlreadyYouTube,
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
      directResolveAlreadyYouTube,
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
  return prioritizeYouTubePlayback(tracks, size, {
    fillQuery,
    allowQueryFill: fillQuery.trim().length > 0,
    maxResolveBudget: tracks.length,
  });
}

function fillQueryForParsedSource(parsed: ParsedTrackSource) {
  if (parsed.type === "search") return parsed.query;
  return "";
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
