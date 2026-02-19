import { fetchAniListUsersOpeningTracks } from "../routes/music/anilist";
import { fetchDeezerChartTracks, fetchDeezerPlaylistTracks } from "../routes/music/deezer";
import { fetchSpotifyPlaylistTracks, fetchSpotifyPopularTracks } from "../routes/music/spotify";
import { searchYouTube } from "../routes/music/youtube";
import { searchYTMusic } from "../routes/music/ytmusic";
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
  const decoded = safeDecodeURIComponent(trimmed);
  const fromUri = decoded.match(/spotify:playlist:([a-zA-Z0-9]+)/i)?.[1];
  if (fromUri) return fromUri;
  const fromUrl = decoded.match(/spotify\.com\/playlist\/([a-zA-Z0-9]+)/i)?.[1];
  if (fromUrl) return fromUrl;
  return decoded.replace(/[?#].*$/, "").trim();
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
      query: "spotify hits",
      payload: { playlistId },
    };
  }

  if (lower === SPOTIFY_POPULAR_PREFIX) {
    return {
      type: "spotify_popular",
      original: categoryQuery,
      query: "top hits",
      payload: null,
    };
  }

  if (lower.startsWith(DEEZER_PLAYLIST_PREFIX)) {
    const playlistId = normalizeDeezerPlaylistId(trimmed.slice(DEEZER_PLAYLIST_PREFIX.length));
    return {
      type: "deezer_playlist",
      original: categoryQuery,
      query: "deezer hits",
      payload: { playlistId },
    };
  }

  if (lower === DEEZER_CHART_PREFIX) {
    return {
      type: "deezer_chart",
      original: categoryQuery,
      query: "charts",
      payload: null,
    };
  }

  if (lower.startsWith(ANILIST_USERS_PREFIX)) {
    const rawUsers = trimmed.slice(ANILIST_USERS_PREFIX.length);
    const usernames = parseUsers(rawUsers);
    return {
      type: "anilist_users",
      original: categoryQuery,
      query: "anime openings",
      payload: { usernames },
    };
  }

  return {
    type: "search",
    original: categoryQuery,
    query: trimmed.length > 0 ? trimmed : "popular hits",
    payload: null,
  };
}

type ResolveTrackPoolOptions = {
  categoryQuery: string;
  size: number;
  fallbackQuery?: string;
};

function fallbackQueryFromParsed(parsed: ParsedTrackSource) {
  switch (parsed.type) {
    case "spotify_playlist":
      return "spotify hits";
    case "spotify_popular":
      return "popular hits";
    case "deezer_playlist":
      return "deezer hits";
    case "deezer_chart":
      return "chart hits";
    case "anilist_users":
      return "anime opening";
    case "search":
      return parsed.query;
  }
}

function nonEmptySlice(tracks: MusicTrack[], size: number) {
  const safeSize = Math.max(1, size);
  const withPreview = tracks.filter((track) => Boolean(track.previewUrl));
  const withoutPreview = tracks.filter((track) => !track.previewUrl);
  return [...withPreview, ...withoutPreview].slice(0, safeSize);
}

const youtubeTrackCache = new Map<string, MusicTrack | null>();
const YOUTUBE_RESOLVE_BUDGET_MAX = 10;

function signature(track: Pick<MusicTrack, "title" | "artist">) {
  return `${track.title.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`;
}

function isYouTubeLikeTrack(track: Pick<MusicTrack, "provider" | "sourceUrl">) {
  if (track.provider === "youtube" || track.provider === "ytmusic") return true;
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
  const hasYtMusicSearch = (process.env.YTMUSIC_SEARCH_URL ?? "").trim().length > 0;

  if (hasYtMusicSearch) {
    const ytmusic = await searchYTMusic(query, safeLimit);
    if (ytmusic.length >= safeLimit) return dedupeTracks(ytmusic, safeLimit);
    const youtube = await searchYouTube(query, safeLimit);
    return dedupeTracks([...ytmusic, ...youtube], safeLimit);
  }

  const youtube = await searchYouTube(query, safeLimit);
  if (youtube.length >= safeLimit) return dedupeTracks(youtube, safeLimit);
  const ytmusic = await searchYTMusic(query, safeLimit);
  return dedupeTracks([...youtube, ...ytmusic], safeLimit);
}

async function resolveYouTubePlayback(track: MusicTrack) {
  if (isYouTubeLikeTrack(track)) {
    return {
      ...track,
      provider: track.provider === "youtube" ? "youtube" : "ytmusic",
      sourceUrl: track.sourceUrl ?? `https://www.youtube.com/watch?v=${track.id}`,
      previewUrl: null,
    } satisfies MusicTrack;
  }

  const key = signature(track);
  if (youtubeTrackCache.has(key)) {
    return youtubeTrackCache.get(key) ?? null;
  }

  const query = `${track.title} ${track.artist} official audio`;
  const candidates = await searchPlayableYouTube(query, 3);
  const picked = candidates[0] ?? null;
  const resolved = picked
    ? ({
        provider: picked.provider === "youtube" ? "youtube" : "ytmusic",
        id: picked.id,
        title: track.title,
        artist: track.artist,
        previewUrl: null,
        sourceUrl: picked.sourceUrl ?? `https://www.youtube.com/watch?v=${picked.id}`,
      } satisfies MusicTrack)
    : null;

  youtubeTrackCache.set(key, resolved);
  return resolved;
}

async function prioritizeYouTubePlayback(tracks: MusicTrack[], size: number, fillQuery: string) {
  const safeSize = Math.max(1, size);
  const scoped = nonEmptySlice(tracks, Math.max(safeSize * 3, safeSize));
  const result: MusicTrack[] = [];
  const seen = new Set<string>();
  let youtubeResolved = 0;
  let queryResolved = 0;
  let directResolveAttempts = 0;
  const resolveBudget = Math.min(
    scoped.length,
    Math.min(YOUTUBE_RESOLVE_BUDGET_MAX, Math.max(4, Math.ceil(safeSize / 2))),
  );

  for (const track of scoped) {
    if (result.length >= safeSize) break;
    if (directResolveAttempts >= resolveBudget) break;
    const key = signature(track);
    if (seen.has(key)) continue;

    directResolveAttempts += 1;
    const youtubePlayback = await resolveYouTubePlayback(track);
    if (youtubePlayback) {
      seen.add(key);
      youtubeResolved += 1;
      result.push(youtubePlayback);
    }
  }

  if (result.length < safeSize && fillQuery.trim().length > 0) {
    const fillQueries = [fillQuery, `${fillQuery} official audio`, `${fillQuery} music playlist`];
    for (const query of fillQueries) {
      if (result.length >= safeSize) break;
      const candidates = await searchPlayableYouTube(query, safeSize);
      for (const track of candidates) {
        if (result.length >= safeSize) break;
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
    resolveBudget,
    droppedNonYoutubeCount: Math.max(0, tracks.length - youtubeResolved),
  });

  return result.slice(0, safeSize);
}

export async function resolveTrackPoolFromSource(
  options: ResolveTrackPoolOptions,
): Promise<MusicTrack[]> {
  const safeSize = Math.max(1, Math.min(options.size, 50));
  const parsed = parseTrackSource(options.categoryQuery);

  try {
    if (parsed.type === "spotify_playlist" && parsed.payload) {
      const tracks = await fetchSpotifyPlaylistTracks(parsed.payload.playlistId, safeSize);
      if (tracks.length > 0) return prioritizeYouTubePlayback(tracks, safeSize, parsed.query);
      logEvent("warn", "track_source_empty_fallback", {
        sourceType: parsed.type,
        categoryQuery: options.categoryQuery,
        requestedSize: safeSize,
      });
    }

    if (parsed.type === "spotify_popular") {
      const tracks = await fetchSpotifyPopularTracks(safeSize);
      if (tracks.length > 0) return prioritizeYouTubePlayback(tracks, safeSize, parsed.query);
      logEvent("warn", "track_source_empty_fallback", {
        sourceType: parsed.type,
        categoryQuery: options.categoryQuery,
        requestedSize: safeSize,
      });
    }

    if (parsed.type === "deezer_playlist" && parsed.payload) {
      const tracks = await fetchDeezerPlaylistTracks(parsed.payload.playlistId, safeSize);
      if (tracks.length > 0) return prioritizeYouTubePlayback(tracks, safeSize, parsed.query);
      logEvent("warn", "track_source_empty_fallback", {
        sourceType: parsed.type,
        categoryQuery: options.categoryQuery,
        requestedSize: safeSize,
      });
    }

    if (parsed.type === "deezer_chart") {
      const tracks = await fetchDeezerChartTracks(safeSize);
      if (tracks.length > 0) return prioritizeYouTubePlayback(tracks, safeSize, parsed.query);
      logEvent("warn", "track_source_empty_fallback", {
        sourceType: parsed.type,
        categoryQuery: options.categoryQuery,
        requestedSize: safeSize,
      });
    }

    if (parsed.type === "anilist_users" && parsed.payload) {
      const tracks = await fetchAniListUsersOpeningTracks(parsed.payload.usernames, safeSize);
      if (tracks.length > 0) return prioritizeYouTubePlayback(tracks, safeSize, parsed.query);
      logEvent("warn", "track_source_empty_fallback", {
        sourceType: parsed.type,
        categoryQuery: options.categoryQuery,
        requestedSize: safeSize,
      });
    }

    const fallbackTracks = await buildTrackPool(fallbackQueryFromParsed(parsed), safeSize);
    return prioritizeYouTubePlayback(fallbackTracks, safeSize, fallbackQueryFromParsed(parsed));
  } catch (error) {
    const fallbackQuery = options.fallbackQuery ?? fallbackQueryFromParsed(parsed);
    logEvent("warn", "track_source_resolution_failed", {
      sourceType: parsed.type,
      categoryQuery: options.categoryQuery,
      fallbackQuery,
      requestedSize: safeSize,
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
    });
    const fallbackTracks = await buildTrackPool(fallbackQuery, safeSize);
    return prioritizeYouTubePlayback(fallbackTracks, safeSize, fallbackQuery);
  }
}
