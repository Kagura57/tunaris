import { fetchJsonWithTimeout } from "./http";
import { getSpotifyAccessToken, spotifyAuthDiagnostics } from "./spotify-auth";
import { readEnvVar } from "../../lib/env";
import { logEvent } from "../../lib/logger";
import { providerMetricsSnapshot } from "../../lib/provider-metrics";
import type { MusicTrack } from "../../services/music-types";

type SpotifyArtist = { name?: string };
type SpotifyItem = {
  id?: string;
  name?: string;
  is_local?: boolean;
  duration_ms?: number | null;
  artists?: SpotifyArtist[];
  preview_url?: string | null;
  external_urls?: {
    spotify?: string;
  };
};
type SpotifyPayload = { tracks?: { items?: SpotifyItem[] } };
type ItunesSearchPayload = {
  results?: Array<{
    trackName?: string;
    artistName?: string;
    previewUrl?: string;
  }>;
};

export async function searchSpotify(query: string, limit = 10): Promise<MusicTrack[]> {
  const token = await getSpotifyAccessToken();
  if (!token) return [];
  const safeLimit = clampSpotifySearchLimit(limit);
  const market = readSpotifyMarket();

  const buildUrl = (withMarket: boolean) => {
    const url = new URL("https://api.spotify.com/v1/search");
    url.searchParams.set("type", "track");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(safeLimit));
    if (withMarket) url.searchParams.set("market", market);
    return url;
  };

  let payload = (await fetchJsonWithTimeout(buildUrl(true), {
    headers: { authorization: `Bearer ${token}` },
  }, {
    context: {
      provider: "spotify",
      query,
    },
  })) as SpotifyPayload | null;

  if (!payload) {
    payload = (await fetchJsonWithTimeout(buildUrl(false), {
      headers: { authorization: `Bearer ${token}` },
    }, {
      context: {
        provider: "spotify",
        route: "search_tracks_fallback_no_market",
        query,
      },
    })) as SpotifyPayload | null;
  }

  const items = payload?.tracks?.items ?? [];
  const mapped = items
    .map((item) => {
      const title = item.name?.trim();
      const artist = item.artists?.[0]?.name?.trim();
      if (!item.id || !title || !artist) return null;
      return {
        provider: "spotify" as const,
        id: item.id,
        title,
        artist,
        previewUrl: item.preview_url ?? null,
        sourceUrl: item.external_urls?.spotify ?? `https://open.spotify.com/track/${item.id}`,
      };
    })
    .filter((value): value is MusicTrack => value !== null);
  return enrichSpotifyTracksWithPreview(mapped, safeLimit);
}

type SpotifyPlaylistTrackEntry = {
  track?: SpotifyItem | null;
  item?: SpotifyItem | null;
  is_local?: boolean;
};

type SpotifyPlaylistTrackPayload = {
  items?: Array<SpotifyPlaylistTrackEntry | SpotifyItem | null>;
  tracks?: {
    items?: Array<SpotifyPlaylistTrackEntry | SpotifyItem | null>;
  };
  total?: number;
};

const DEFAULT_SPOTIFY_POPULAR_PLAYLIST_IDS = ["37i9dQZEVXbMDoHDwVN2tF"];
const itunesPreviewCache = new Map<string, string | null>();
const SPOTIFY_DEV_SEARCH_LIMIT_MAX = 10;
const SPOTIFY_RATE_LIMIT_COOLDOWN_MS = 20_000;
const SPOTIFY_PLAYLIST_RETRY_ATTEMPTS = 4;
const SPOTIFY_PLAYLIST_RETRY_DELAY_MS = 350;
const SPOTIFY_PLAYLIST_RETRY_BUDGET_MS = 20_000;
let spotifyPlaylistRateLimitedUntilMs = 0;

export const SPOTIFY_RATE_LIMITED_ERROR = "SPOTIFY_RATE_LIMITED";

export function resetSpotifyPlaylistRateLimitForTests() {
  spotifyPlaylistRateLimitedUntilMs = 0;
}

function readSpotifyApiMode() {
  const raw = (readEnvVar("SPOTIFY_API_MODE") ?? "").trim().toLowerCase();
  if (raw === "extended" || raw === "extended_quota") return "extended";
  return "development";
}

export function spotifyPlaylistRateLimitRetryAfterMs() {
  return Math.max(0, spotifyPlaylistRateLimitedUntilMs - Date.now());
}

function isSpotifyPlaylistRateLimited() {
  return spotifyPlaylistRateLimitedUntilMs > Date.now();
}

function registerSpotifyRateLimit(retryAfterMs?: number | null) {
  const fallbackMs = SPOTIFY_RATE_LIMIT_COOLDOWN_MS;
  const normalizedRetryAfterMs =
    typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.max(1_000, Math.min(Math.round(retryAfterMs), SPOTIFY_PLAYLIST_RETRY_BUDGET_MS))
      : fallbackMs;
  spotifyPlaylistRateLimitedUntilMs = Math.max(
    spotifyPlaylistRateLimitedUntilMs,
    Date.now() + normalizedRetryAfterMs,
  );
}

function registerSpotifyRateLimitFromMetrics(retryAfterMs?: number | null) {
  const spotify = providerMetricsSnapshot().spotify;
  if (!spotify || spotify.lastStatus !== 429) return false;

  const lastSeenAtMs = Date.parse(spotify.lastSeenAt);
  if (Number.isFinite(lastSeenAtMs) && Date.now() - lastSeenAtMs > 10_000) {
    return false;
  }

  registerSpotifyRateLimit(retryAfterMs ?? SPOTIFY_RATE_LIMIT_COOLDOWN_MS);
  return true;
}

function spotifySearchLimitMax() {
  return readSpotifyApiMode() === "extended" ? 50 : SPOTIFY_DEV_SEARCH_LIMIT_MAX;
}

function clampSpotifySearchLimit(limit: number) {
  return Math.max(1, Math.min(limit, spotifySearchLimitMax()));
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

function readPopularPlaylistIds() {
  const raw = readEnvVar("SPOTIFY_POPULAR_PLAYLIST_IDS");
  if (!raw) return DEFAULT_SPOTIFY_POPULAR_PLAYLIST_IDS;
  const parsed = raw
    .split(",")
    .map((value) => normalizeSpotifyPlaylistId(value))
    .filter((value) => value.length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_SPOTIFY_POPULAR_PLAYLIST_IDS;
}

function readSpotifyMarket() {
  const raw = readEnvVar("SPOTIFY_MARKET") ?? "US";
  const normalized = raw.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(normalized)) return normalized;
  return "US";
}

function toTrack(item: SpotifyItem | null | undefined) {
  if (!item) return null;
  const title = item.name?.trim();
  const artist = item.artists?.[0]?.name?.trim();
  if (!item.id || !title || !artist) return null;
  const durationSec =
    typeof item.duration_ms === "number" && Number.isFinite(item.duration_ms)
      ? Math.max(1, Math.round(item.duration_ms / 1000))
      : null;
  return {
    provider: "spotify" as const,
    id: item.id,
    title,
    artist,
    durationSec,
    previewUrl: item.preview_url ?? null,
    sourceUrl: item.external_urls?.spotify ?? `https://open.spotify.com/track/${item.id}`,
  };
}

function readPlaylistTrackEntry(
  entry: SpotifyPlaylistTrackEntry | SpotifyItem | null | undefined,
) {
  if (!entry) {
    return { track: null, isLocal: false };
  }

  const playlistEntry = entry as SpotifyPlaylistTrackEntry;
  if ("track" in playlistEntry || "item" in playlistEntry || "is_local" in playlistEntry) {
    const track = playlistEntry.track ?? playlistEntry.item ?? null;
    const isLocal = playlistEntry.is_local === true || track?.is_local === true;
    return { track, isLocal };
  }

  const directTrack = entry as SpotifyItem;
  const isLocal = directTrack.is_local === true;
  const track = isLocal ? null : directTrack;
  return { track, isLocal };
}

function mapSpotifyPlaylistItems(items: Array<SpotifyPlaylistTrackEntry | SpotifyItem | null>) {
  let skippedLocalTracks = 0;
  let skippedNullTracks = 0;
  const dedupeSignatures = new Set<string>();
  const tracks: MusicTrack[] = [];

  for (const item of items) {
    const { track, isLocal } = readPlaylistTrackEntry(item);
    if (isLocal) {
      skippedLocalTracks += 1;
      continue;
    }
    if (!track) {
      skippedNullTracks += 1;
      continue;
    }

    const mapped = toTrack(track);
    if (!mapped) {
      skippedNullTracks += 1;
      continue;
    }

    const signature = `${mapped.title.toLowerCase()}::${mapped.artist.toLowerCase()}`;
    if (dedupeSignatures.has(signature)) continue;
    dedupeSignatures.add(signature);
    tracks.push(mapped);
  }

  return {
    tracks,
    skippedLocalTracks,
    skippedNullTracks,
  };
}

function normalizeText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trackKey(track: Pick<MusicTrack, "title" | "artist">) {
  return `${normalizeText(track.title)}::${normalizeText(track.artist)}`;
}

function scoreItunesCandidate(
  track: Pick<MusicTrack, "title" | "artist">,
  candidate: { title: string; artist: string },
) {
  const expectedTitle = normalizeText(track.title);
  const expectedArtist = normalizeText(track.artist);
  const candidateTitle = normalizeText(candidate.title);
  const candidateArtist = normalizeText(candidate.artist);

  let score = 0;
  if (expectedTitle === candidateTitle) score += 4;
  else if (expectedTitle.includes(candidateTitle) || candidateTitle.includes(expectedTitle)) score += 2;

  if (expectedArtist === candidateArtist) score += 4;
  else if (expectedArtist.includes(candidateArtist) || candidateArtist.includes(expectedArtist)) score += 2;

  return score;
}

async function resolveItunesPreviewForTrack(track: Pick<MusicTrack, "title" | "artist">) {
  const cacheKey = trackKey(track);
  if (itunesPreviewCache.has(cacheKey)) {
    return itunesPreviewCache.get(cacheKey) ?? null;
  }

  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", `${track.title} ${track.artist}`);
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "12");

  const payload = (await fetchJsonWithTimeout(url, {}, {
    timeoutMs: 5_000,
    retries: 1,
    retryDelayMs: 300,
    context: {
      provider: "itunes",
      route: "search_preview",
      title: track.title,
      artist: track.artist,
    },
  })) as ItunesSearchPayload | null;

  const candidates = (payload?.results ?? [])
    .map((item) => {
      const previewUrl = item.previewUrl?.trim();
      const title = item.trackName?.trim();
      const artist = item.artistName?.trim();
      if (!previewUrl || !title || !artist) return null;
      return {
        previewUrl,
        title,
        artist,
      };
    })
    .filter((value): value is { previewUrl: string; title: string; artist: string } => value !== null);

  const best = candidates
    .map((candidate) => ({
      candidate,
      score: scoreItunesCandidate(track, candidate),
    }))
    .sort((a, b) => b.score - a.score)[0];

  const resolved = best && best.score >= 4 ? best.candidate.previewUrl : null;
  itunesPreviewCache.set(cacheKey, resolved);
  return resolved;
}

async function enrichSpotifyTracksWithPreview(tracks: MusicTrack[], targetPreviewCount: number) {
  const safeTarget = Math.max(1, targetPreviewCount);
  const enriched: MusicTrack[] = [];
  let previewCount = tracks.filter((track) => Boolean(track.previewUrl)).length;

  for (const track of tracks) {
    if (track.previewUrl || previewCount >= safeTarget) {
      enriched.push(track);
      continue;
    }

    const previewUrl = await resolveItunesPreviewForTrack(track);
    if (previewUrl) {
      enriched.push({
        ...track,
        previewUrl,
      });
      previewCount += 1;
      continue;
    }

    enriched.push(track);
  }

  return enriched;
}

function prioritizeByPreview(tracks: MusicTrack[], limit: number) {
  const withPreview = tracks.filter((track) => Boolean(track.previewUrl));
  const withoutPreview = tracks.filter((track) => !track.previewUrl);
  return [...withPreview, ...withoutPreview].slice(0, Math.max(1, limit));
}

export async function fetchSpotifyPlaylistTracks(
  playlistId: string,
  limit = 20,
  _options: { enrichPreview?: boolean } = {},
): Promise<MusicTrack[]> {
  const token = await getSpotifyAccessToken();
  if (!token) {
    const diagnostics = spotifyAuthDiagnostics();
    console.error("[spotify] missing access token for playlist fetch", {
      playlistId,
      diagnostics,
    });
    logEvent("error", "spotify_playlist_missing_access_token", {
      playlistId,
      diagnostics,
    });
    return [];
  }

  const normalizedPlaylistId = normalizeSpotifyPlaylistId(playlistId);
  if (!normalizedPlaylistId) {
    logEvent("warn", "spotify_playlist_invalid_id", {
      playlistId,
    });
    return [];
  }

  try {
    const safeLimit = 100;
    if (isSpotifyPlaylistRateLimited()) {
      throw new Error(SPOTIFY_RATE_LIMITED_ERROR);
    }

    const url = new URL(
      `https://api.spotify.com/v1/playlists/${encodeURIComponent(normalizedPlaylistId)}/tracks`,
    );
    url.searchParams.set("limit", String(safeLimit));
    url.searchParams.set("offset", "0");

    let observedRetryAfterMs: number | null = null;
    const payload = (await fetchJsonWithTimeout(
      url,
      {
        headers: { authorization: `Bearer ${token}` },
      },
      {
        timeoutMs: 4_000,
        retries: SPOTIFY_PLAYLIST_RETRY_ATTEMPTS,
        retryDelayMs: SPOTIFY_PLAYLIST_RETRY_DELAY_MS,
        maxRetryAfterMs: SPOTIFY_PLAYLIST_RETRY_BUDGET_MS,
        maxTotalRetryMs: SPOTIFY_PLAYLIST_RETRY_BUDGET_MS,
        context: {
          provider: "spotify",
          route: "playlist_tracks_single_page",
          playlistId: normalizedPlaylistId,
          offset: 0,
          requestedLimit: safeLimit,
        },
        onHttpError: ({ status, retryAfterMs }) => {
          if (status !== 429) return;
          if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
            observedRetryAfterMs = Math.max(observedRetryAfterMs ?? 0, Math.round(retryAfterMs));
          } else if (observedRetryAfterMs === null) {
            observedRetryAfterMs = SPOTIFY_RATE_LIMIT_COOLDOWN_MS;
          }
        },
      },
    )) as SpotifyPlaylistTrackPayload | null;

    const rawItems = Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.tracks?.items)
        ? payload.tracks.items
        : null;

    if (!Array.isArray(rawItems)) {
      if (registerSpotifyRateLimitFromMetrics(observedRetryAfterMs)) {
        throw new Error(SPOTIFY_RATE_LIMITED_ERROR);
      }

      console.error("[spotify] single-page playlist fetch failed", {
        playlistId: normalizedPlaylistId,
        sourcePlaylistId: playlistId,
        requestedLimit: safeLimit,
        hasPayload: Boolean(payload),
      });
      logEvent("warn", "spotify_playlist_tracks_empty", {
        playlistId: normalizedPlaylistId,
        endpointUsed: "tracks",
        metadataTotal: null,
        pagesFetched: 0,
        fetchedItems: 0,
        skippedLocalTracks: 0,
        skippedNullTracks: 0,
        requestedLimit: safeLimit,
      });
      return [];
    }

    const items = rawItems.filter((entry): entry is SpotifyPlaylistTrackEntry | SpotifyItem =>
      Boolean(entry && typeof entry === "object"),
    );
    const mapped = mapSpotifyPlaylistItems(items);
    const deduped = mapped.tracks.slice(0, safeLimit);
    console.log("Spotify tracks mapped:", deduped.length);
    if (deduped.length === 0) {
      console.error("[spotify] no usable tracks after playlist parsing", {
        playlistId: normalizedPlaylistId,
        sourcePlaylistId: playlistId,
        endpointUsed: "tracks",
        marketUsed: "none",
        metadataTotal: null,
        pagesFetched: 1,
        fetchedItems: items.length,
        skippedLocalTracks: mapped.skippedLocalTracks,
        skippedNullTracks: mapped.skippedNullTracks,
        requestedLimit: safeLimit,
      });
      logEvent("warn", "spotify_playlist_tracks_empty", {
        playlistId: normalizedPlaylistId,
        endpointUsed: "tracks",
        metadataTotal: null,
        pagesFetched: 1,
        fetchedItems: items.length,
        skippedLocalTracks: mapped.skippedLocalTracks,
        skippedNullTracks: mapped.skippedNullTracks,
        requestedLimit: safeLimit,
      });
      return [];
    }

    spotifyPlaylistRateLimitedUntilMs = 0;

    const previewBefore = deduped.filter((track) => Boolean(track.previewUrl)).length;
    logEvent("info", "spotify_playlist_preview_coverage", {
      playlistId: normalizedPlaylistId,
      sourcePlaylistId: playlistId,
      market: "none",
      marketUsed: "none",
      endpointUsed: "tracks",
      requestedLimit: safeLimit,
      metadataTotal: null,
      pagesFetched: 1,
      fetchedItems: items.length,
      dedupedCount: deduped.length,
      skippedLocalTracks: mapped.skippedLocalTracks,
      skippedNullTracks: mapped.skippedNullTracks,
      previewBefore,
      previewAfter: previewBefore,
    });
    return deduped;
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    if (message === SPOTIFY_RATE_LIMITED_ERROR) {
      logEvent("warn", "spotify_playlist_rate_limited", {
        playlistId: normalizedPlaylistId,
        sourcePlaylistId: playlistId,
        requestedLimit: 100,
        retryAfterMs: spotifyPlaylistRateLimitRetryAfterMs(),
      });
      throw error instanceof Error ? error : new Error(SPOTIFY_RATE_LIMITED_ERROR);
    }
    console.error("[spotify] fetchSpotifyPlaylistTracks unexpected failure", {
      playlistId: normalizedPlaylistId,
      limit,
      error: message,
    });
    logEvent("error", "spotify_playlist_tracks_unexpected_failure", {
      playlistId: normalizedPlaylistId,
      limit,
      error: message,
    });
    return [];
  }
}

export async function fetchSpotifyPopularTracks(
  limit = 20,
  options: { enrichPreview?: boolean } = {},
): Promise<MusicTrack[]> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const playlistIds = readPopularPlaylistIds();
  const merged: MusicTrack[] = [];
  const seen = new Set<string>();

  for (const playlistId of playlistIds) {
    const tracks = await fetchSpotifyPlaylistTracks(playlistId, safeLimit, options);
    for (const track of tracks) {
      const signature = `${track.title.toLowerCase()}::${track.artist.toLowerCase()}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      merged.push(track);
      if (merged.length >= safeLimit * 3) {
        return prioritizeByPreview(merged, safeLimit);
      }
    }
  }

  return prioritizeByPreview(merged, safeLimit);
}
