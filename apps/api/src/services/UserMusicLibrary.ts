import { Buffer } from "node:buffer";
import { fetchJsonWithTimeout } from "../routes/music/http";
import { logEvent } from "../lib/logger";
import type { MusicTrack } from "./music-types";
import { resolveTracksToPlayableYouTube } from "./TrackSourceResolver";
import { musicAccountRepository, type MusicProvider } from "../repositories/MusicAccountRepository";
import { resolvedTrackRepository } from "../repositories/ResolvedTrackRepository";
import { userLikedTrackRepository, type LibraryProvider } from "../repositories/UserLikedTrackRepository";
import { buildSyncedUserLibraryTrackPool } from "./MusicAggregator";

type SpotifyTokenRefreshPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

type SpotifySavedTracksPayload = {
  items?: Array<{
    added_at?: string;
    track?: {
      id?: string;
      name?: string;
      artists?: Array<{ name?: string }>;
      duration_ms?: number;
      preview_url?: string | null;
      external_urls?: { spotify?: string };
    };
  }>;
  total?: number;
  next?: string | null;
};

type SpotifyPlaylistsPayload = {
  items?: Array<{
    id?: string;
    name?: string;
    description?: string | null;
    images?: Array<{ url?: string }>;
    external_urls?: { spotify?: string };
    owner?: { display_name?: string };
    tracks?: { total?: number };
  }>;
  total?: number;
  next?: string | null;
};

type DeezerTracksPayload = {
  data?: Array<{
    id?: number;
    title?: string;
    artist?: { name?: string };
    duration?: number;
    time_add?: number;
    preview?: string | null;
  }>;
  total?: number;
  next?: string;
};

type DeezerPlaylistsPayload = {
  data?: Array<{
    id?: number;
    title?: string;
    description?: string;
    picture_medium?: string;
    link?: string;
    creator?: { name?: string };
    nb_tracks?: number;
  }>;
  total?: number;
  next?: string;
};

export type UserLibraryPlaylist = {
  provider: MusicProvider;
  id: string;
  name: string;
  description: string;
  imageUrl: string | null;
  externalUrl: string;
  owner: string | null;
  trackCount: number | null;
  sourceQuery: string;
};

type SyncedLibrarySourceTrack = {
  provider: LibraryProvider;
  sourceId: string;
  title: string;
  artist: string;
  durationMs: number | null;
  addedAtMs: number;
};

export type LibrarySyncProgressUpdate = {
  stage: "syncing" | "saving" | "completed";
  progress: number;
  processedTracks: number;
  totalTracks: number | null;
};

export class SpotifySyncRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("SPOTIFY_RATE_LIMITED");
    this.retryAfterMs = Math.max(1_000, Math.round(retryAfterMs));
  }
}

function parseDateMs(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readSpotifyCredentials() {
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim() ?? "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

async function refreshSpotifyAccessToken(userId: string) {
  const link = await musicAccountRepository.getLink(userId, "spotify");
  if (!link || !link.refreshToken) return link;
  const creds = readSpotifyCredentials();
  if (!creds) return link;
  console.log("[spotify-liked-debug] refresh_token_start", {
    userId,
    hasRefreshToken: Boolean(link.refreshToken),
    expiresAtMs: link.expiresAtMs ?? null,
  });

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", link.refreshToken);
  const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  const payload = (await fetchJsonWithTimeout(
    "https://accounts.spotify.com/api/token",
    {
      method: "POST",
      headers: {
        authorization: `Basic ${basicAuth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
    {
      timeoutMs: 6_000,
      retries: 1,
      context: {
        provider: "spotify",
        route: "user_refresh_token",
      },
    },
  )) as SpotifyTokenRefreshPayload | null;

  if (!payload?.access_token) {
    console.log("[spotify-liked-debug] refresh_token_empty_payload", {
      userId,
      hasAccessToken: false,
      hasRefreshToken: Boolean(payload?.refresh_token),
      scope: payload?.scope ?? null,
    });
    return link;
  }
  console.log("[spotify-liked-debug] refresh_token_success", {
    userId,
    hasAccessToken: true,
    hasRefreshToken: Boolean(payload.refresh_token),
    scope: payload.scope ?? null,
    expiresInSec: payload.expires_in ?? null,
  });

  const expiresAtMs =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? Date.now() + Math.max(60, payload.expires_in) * 1000
      : link.expiresAtMs;
  await musicAccountRepository.upsertLink({
    userId,
    provider: "spotify",
    providerUserId: link.providerUserId,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? link.refreshToken,
    scope: payload.scope ?? link.scope,
    expiresAtMs,
  });
  return await musicAccountRepository.getLink(userId, "spotify");
}

async function getValidSpotifyLink(userId: string) {
  const link = await musicAccountRepository.getLink(userId, "spotify");
  if (!link) return null;
  const expiresSoon =
    typeof link.expiresAtMs === "number" && Number.isFinite(link.expiresAtMs)
      ? link.expiresAtMs <= Date.now() + 20_000
      : false;
  if (!expiresSoon) return link;
  return refreshSpotifyAccessToken(userId);
}

async function fetchSpotifyLikedTracksRaw(userId: string, limit: number) {
  const link = await getValidSpotifyLink(userId);
  console.log("[spotify-liked-debug] link_status", {
    userId,
    hasLink: Boolean(link),
    hasAccessToken: Boolean(link?.accessToken),
    hasRefreshToken: Boolean(link?.refreshToken),
    scope: link?.scope ?? null,
    expiresAtMs: link?.expiresAtMs ?? null,
  });
  if (!link?.accessToken) {
    return { tracks: [] as MusicTrack[], total: null as number | null };
  }
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const tracks: MusicTrack[] = [];
  let total: number | null = null;
  let offset = 0;

  while (tracks.length < safeLimit) {
    const pageLimit = Math.min(50, safeLimit - tracks.length);
    const url = new URL("https://api.spotify.com/v1/me/tracks");
    url.searchParams.set("limit", String(pageLimit));
    url.searchParams.set("offset", String(offset));
    let payload: SpotifySavedTracksPayload | null = null;
    let responseStatus: number | null = null;
    let responseItemCount: number | null = null;
    let firstItemJson: string | null = null;
    try {
      payload = (await fetchJsonWithTimeout(
        url,
        {
          headers: {
            authorization: `Bearer ${link.accessToken}`,
          },
        },
        {
          timeoutMs: 6_000,
          retries: 1,
          context: {
            provider: "spotify",
            route: "user_saved_tracks",
          },
          onSuccess: ({ status, data }) => {
            responseStatus = status;
            const items = Array.isArray((data as SpotifySavedTracksPayload | null)?.items)
              ? ((data as SpotifySavedTracksPayload).items ?? [])
              : [];
            responseItemCount = items.length;
            firstItemJson = items.length > 0 ? JSON.stringify(items[0], null, 2) : null;
          },
          onHttpError: ({ status }) => {
            responseStatus = status;
          },
        },
      )) as SpotifySavedTracksPayload | null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
      console.log("[spotify-liked-debug] fetch_error", {
        userId,
        offset,
        pageLimit,
        error: message,
      });
      throw error;
    }
    console.log("========== [spotify-liked-debug] /me/tracks raw_response ==========", {
      userId,
      offset,
      pageLimit,
      status: responseStatus,
      itemCount: responseItemCount,
      firstItem: firstItemJson,
    });

    const payloadItems = Array.isArray(payload?.items) ? payload.items : [];
    const sampleItems = payloadItems.slice(0, 3).map((item) => ({
      id: item.track?.id ?? null,
      title: item.track?.name ?? null,
      artist: item.track?.artists?.[0]?.name ?? null,
      hasPreview: Boolean(item.track?.preview_url),
    }));
    console.log("[spotify-liked-debug] fetch_page", {
      userId,
      offset,
      pageLimit,
      payloadTotal: payload?.total ?? null,
      itemCount: payloadItems.length,
      hasNext: Boolean(payload?.next),
      sampleItems,
    });
    const page = Array.isArray(payload?.items) ? payload.items : [];
    if (typeof payload?.total === "number" && Number.isFinite(payload.total)) {
      total = payload.total;
    }
    if (page.length <= 0) break;
    for (const item of page) {
      const track = item.track;
      const id = track?.id?.trim() ?? "";
      const title = track?.name?.trim() ?? "";
      const artist = track?.artists?.[0]?.name?.trim() ?? "";
      if (!id || !title || !artist) continue;
      tracks.push({
        provider: "spotify",
        id,
        title,
        artist,
        previewUrl: track?.preview_url ?? null,
        sourceUrl: track?.external_urls?.spotify ?? `https://open.spotify.com/track/${id}`,
      });
      if (tracks.length >= safeLimit) break;
    }

    if (!payload?.next || page.length < pageLimit) break;
    offset += pageLimit;
  }

  console.log("[spotify-liked-debug] fetch_done", {
    userId,
    requestedLimit: safeLimit,
    returnedTracks: tracks.length,
    spotifyTotal: total,
  });

  return {
    tracks,
    total,
  };
}

async function fetchDeezerLikedTracksRaw(userId: string, limit: number) {
  const link = await musicAccountRepository.getLink(userId, "deezer");
  if (!link?.accessToken) return { tracks: [] as MusicTrack[], total: null as number | null };
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const tracks: MusicTrack[] = [];
  let total: number | null = null;
  let nextUrl: URL | null = new URL("https://api.deezer.com/user/me/tracks");
  nextUrl.searchParams.set("access_token", link.accessToken);
  nextUrl.searchParams.set("limit", String(Math.min(50, safeLimit)));

  while (nextUrl && tracks.length < safeLimit) {
    const payload = (await fetchJsonWithTimeout(
      nextUrl,
      {},
      {
        timeoutMs: 6_000,
        retries: 1,
        context: {
          provider: "deezer",
          route: "user_saved_tracks",
        },
      },
    )) as DeezerTracksPayload | null;

    if (typeof payload?.total === "number" && Number.isFinite(payload.total)) {
      total = payload.total;
    }
    for (const item of payload?.data ?? []) {
      const id = typeof item.id === "number" ? String(item.id) : "";
      const title = item.title?.trim() ?? "";
      const artist = item.artist?.name?.trim() ?? "";
      if (!id || !title || !artist) continue;
      tracks.push({
        provider: "deezer",
        id,
        title,
        artist,
        previewUrl: item.preview ?? null,
        sourceUrl: `https://www.deezer.com/track/${id}`,
      });
      if (tracks.length >= safeLimit) break;
    }

    if (!payload?.next || tracks.length >= safeLimit) break;
    try {
      nextUrl = new URL(payload.next);
    } catch {
      nextUrl = null;
    }
  }

  return {
    tracks,
    total,
  };
}

async function fetchSpotifyLikedTracksForSync(
  userId: string,
  onProgress?: (update: LibrarySyncProgressUpdate) => void | Promise<void>,
) {
  let link = await getValidSpotifyLink(userId);
  if (!link?.accessToken) {
    return { tracks: [] as SyncedLibrarySourceTrack[], total: null as number | null };
  }

  const tracks: SyncedLibrarySourceTrack[] = [];
  let total: number | null = null;
  let offset = 0;
  const maxTracks = 10_000;
  let refreshRetried = false;

  while (tracks.length < maxTracks) {
    const pageLimit = Math.min(50, maxTracks - tracks.length);
    const url = new URL("https://api.spotify.com/v1/me/tracks");
    url.searchParams.set("limit", String(pageLimit));
    url.searchParams.set("offset", String(offset));
    let lastStatus: number | null = null;
    let lastRetryAfterMs: number | null = null;
    let lastErrorDetail: string | null = null;
    const payload = (await fetchJsonWithTimeout(
      url,
      {
        headers: {
          authorization: `Bearer ${link.accessToken}`,
        },
      },
      {
        timeoutMs: 8_000,
        retries: 1,
        context: {
          provider: "spotify",
          route: "user_saved_tracks_sync",
        },
        onSuccess: ({ status }) => {
          lastStatus = status;
        },
        onHttpError: ({ status, retryAfterMs, errorDetail }) => {
          lastStatus = status;
          lastRetryAfterMs = retryAfterMs;
          lastErrorDetail = errorDetail;
        },
      },
    )) as SpotifySavedTracksPayload | null;
    if (!payload) {
      if (lastStatus === 429) {
        throw new SpotifySyncRateLimitError(lastRetryAfterMs ?? 30_000);
      }
      if (lastStatus === 401 && !refreshRetried) {
        refreshRetried = true;
        const refreshed = await refreshSpotifyAccessToken(userId);
        if (refreshed?.accessToken) {
          link = refreshed;
          continue;
        }
      }
      if (lastStatus === 401) {
        throw new Error("SPOTIFY_SYNC_UNAUTHORIZED");
      }
      if (lastStatus === 403) {
        const detail = (lastErrorDetail ?? "").toLowerCase();
        if (detail.includes("scope")) {
          throw new Error("SPOTIFY_SYNC_SCOPE_MISSING_USER_LIBRARY_READ");
        }
        throw new Error("SPOTIFY_SYNC_FORBIDDEN");
      }
      if (lastStatus === 400) {
        throw new Error("SPOTIFY_SYNC_BAD_REQUEST");
      }
      if (typeof lastStatus === "number") {
        throw new Error(`SPOTIFY_SYNC_FETCH_FAILED_HTTP_${lastStatus}`);
      }
      throw new Error("SPOTIFY_SYNC_FETCH_FAILED");
    }

    if (typeof payload?.total === "number" && Number.isFinite(payload.total)) {
      total = payload.total;
    }
    const page = Array.isArray(payload?.items) ? payload.items : [];
    if (page.length <= 0) break;

    for (const item of page) {
      const id = item.track?.id?.trim() ?? "";
      const title = item.track?.name?.trim() ?? "";
      const artist = item.track?.artists?.[0]?.name?.trim() ?? "";
      if (!id || !title || !artist) continue;
      const durationMs =
        typeof item.track?.duration_ms === "number" && Number.isFinite(item.track.duration_ms)
          ? Math.max(0, Math.round(item.track.duration_ms))
          : null;
      tracks.push({
        provider: "spotify",
        sourceId: id,
        title,
        artist,
        durationMs,
        addedAtMs: parseDateMs(item.added_at) ?? Date.now(),
      });
      if (tracks.length >= maxTracks) break;
    }

    if (onProgress) {
      const totalTracks = typeof total === "number" && Number.isFinite(total) ? total : null;
      const progress = totalTracks && totalTracks > 0
        ? Math.max(1, Math.min(95, Math.round((tracks.length / totalTracks) * 90)))
        : 0;
      await onProgress({
        stage: "syncing",
        progress,
        processedTracks: tracks.length,
        totalTracks,
      });
    }

    if (!payload?.next || page.length < pageLimit) break;
    offset += pageLimit;
  }

  return { tracks, total };
}

async function fetchDeezerLikedTracksForSync(userId: string) {
  const link = await musicAccountRepository.getLink(userId, "deezer");
  if (!link?.accessToken) {
    return { tracks: [] as SyncedLibrarySourceTrack[], total: null as number | null };
  }
  const tracks: SyncedLibrarySourceTrack[] = [];
  let total: number | null = null;
  let nextUrl: URL | null = new URL("https://api.deezer.com/user/me/tracks");
  nextUrl.searchParams.set("access_token", link.accessToken);
  nextUrl.searchParams.set("limit", "50");
  const maxTracks = 10_000;

  while (nextUrl && tracks.length < maxTracks) {
    const payload = (await fetchJsonWithTimeout(
      nextUrl,
      {},
      {
        timeoutMs: 8_000,
        retries: 1,
        context: {
          provider: "deezer",
          route: "user_saved_tracks_sync",
        },
      },
    )) as DeezerTracksPayload | null;
    if (typeof payload?.total === "number" && Number.isFinite(payload.total)) {
      total = payload.total;
    }
    for (const item of payload?.data ?? []) {
      const id = typeof item.id === "number" ? String(item.id) : "";
      const title = item.title?.trim() ?? "";
      const artist = item.artist?.name?.trim() ?? "";
      if (!id || !title || !artist) continue;
      const durationMs =
        typeof item.duration === "number" && Number.isFinite(item.duration)
          ? Math.max(0, Math.round(item.duration * 1000))
          : null;
      const addedAtMs =
        typeof item.time_add === "number" && Number.isFinite(item.time_add)
          ? Math.max(0, Math.round(item.time_add * 1000))
          : Date.now();
      tracks.push({
        provider: "deezer",
        sourceId: id,
        title,
        artist,
        durationMs,
        addedAtMs,
      });
      if (tracks.length >= maxTracks) break;
    }
    if (!payload?.next || tracks.length >= maxTracks) break;
    try {
      nextUrl = new URL(payload.next);
    } catch {
      nextUrl = null;
    }
  }

  return { tracks, total };
}

function dedupeTracks(tracks: MusicTrack[], size: number) {
  const seen = new Set<string>();
  const deduped: MusicTrack[] = [];
  for (const track of tracks) {
    const key = `${track.title.toLowerCase()}::${track.artist.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(track);
    if (deduped.length >= size) break;
  }
  return deduped;
}

function sourceSignature(track: Pick<MusicTrack, "title" | "artist">) {
  return `${track.title.toLowerCase()}::${track.artist.toLowerCase()}`;
}

export async function fetchUserLikedTracks(
  userId: string,
  provider: MusicProvider,
  limit = 80,
) {
  if (provider === "spotify") return fetchSpotifyLikedTracksRaw(userId, limit);
  return fetchDeezerLikedTracksRaw(userId, limit);
}

export async function fetchUserLikedTracksForProviders(input: {
  userId: string;
  providers: MusicProvider[];
  size: number;
}) {
  const userId = input.userId.trim();
  const safeSize = Math.max(1, Math.min(input.size, 120));
  const providers = input.providers.filter(
    (provider): provider is LibraryProvider => provider === "spotify" || provider === "deezer",
  );
  const fetchWindowBase = Math.max(30, safeSize * 3);
  const fetchWindowCap = 400;
  const fetchAttempts = 3;
  const mergedSourceTracks = new Map<string, MusicTrack>();
  const fetchCountsByAttempt: number[] = [];

  for (let attempt = 0; attempt < fetchAttempts; attempt += 1) {
    const fetchSize = Math.min(fetchWindowCap, fetchWindowBase * (attempt + 1));
    const merged = await buildSyncedUserLibraryTrackPool({
      userId,
      providers,
      size: fetchSize,
    });
    fetchCountsByAttempt.push(merged.length);
    for (const track of merged) {
      const key = `${track.provider}:${track.id}`;
      if (!mergedSourceTracks.has(key)) {
        mergedSourceTracks.set(key, track);
      }
    }
    if (mergedSourceTracks.size >= Math.max(safeSize * 4, 120)) {
      break;
    }
  }

  const merged = [...mergedSourceTracks.values()];
  const fetchedCount = merged.length;
  const initialDedupeLimit = Math.max(safeSize * 3, safeSize);
  const deduped = dedupeTracks(merged, initialDedupeLimit);
  let playable = await resolveTracksToPlayableYouTube(deduped, safeSize);
  let expandedDedupedCount = deduped.length;
  let topUpResolvedCount = 0;
  let secondPassTriggered = false;

  if (playable.length < safeSize && deduped.length < merged.length) {
    secondPassTriggered = true;
    const expandedDedupeLimit = Math.min(
      merged.length,
      Math.max(initialDedupeLimit + safeSize, safeSize * 8, safeSize + 120),
    );
    const expandedDeduped = dedupeTracks(merged, expandedDedupeLimit);
    expandedDedupedCount = expandedDeduped.length;
    const alreadyAttempted = new Set(deduped.map((track) => sourceSignature(track)));
    const overflowCandidates = expandedDeduped.filter((track) => !alreadyAttempted.has(sourceSignature(track)));
    const needed = Math.max(0, safeSize - playable.length);
    if (needed > 0 && overflowCandidates.length > 0) {
      const topUp = await resolveTracksToPlayableYouTube(overflowCandidates, needed);
      topUpResolvedCount = topUp.length;
      playable = dedupeTracks([...playable, ...topUp], safeSize);
    }
  }

  logEvent("info", "user_liked_tracks_resolved_from_synced_library", {
    userId,
    providers,
    requestedSize: safeSize,
    fetchWindowBase,
    fetchWindowCap,
    fetchAttempts,
    fetchCountsByAttempt,
    syncedFetchedCount: fetchedCount,
    dedupedCount: deduped.length,
    expandedDedupedCount,
    secondPassTriggered,
    topUpResolvedCount,
    playableCount: playable.length,
  });
  return playable;
}

export async function syncUserLikedTracksLibrary(input: {
  userId: string;
  provider: LibraryProvider;
  onProgress?: (update: LibrarySyncProgressUpdate) => void | Promise<void>;
}) {
  const provider = input.provider;
  const userId = input.userId.trim();
  if (!userId) {
    throw new Error("INVALID_USER_ID");
  }

  const fetched =
    provider === "spotify"
      ? await fetchSpotifyLikedTracksForSync(userId, input.onProgress)
      : await fetchDeezerLikedTracksForSync(userId);
  const uniqueBySource = new Map<string, SyncedLibrarySourceTrack>();
  for (const track of fetched.tracks) {
    const key = `${track.provider}:${track.sourceId}`;
    if (!uniqueBySource.has(key)) {
      uniqueBySource.set(key, track);
    }
  }
  const normalized = [...uniqueBySource.values()];

  if (input.onProgress) {
    await input.onProgress({
      stage: "saving",
      progress: 96,
      processedTracks: normalized.length,
      totalTracks: fetched.total,
    });
  }

  await resolvedTrackRepository.upsertSourceMetadataMany(
    normalized.map((track) => ({
      provider: track.provider,
      sourceId: track.sourceId,
      title: track.title,
      artist: track.artist,
      durationMs: track.durationMs,
    })),
  );

  const replaced = await userLikedTrackRepository.replaceForUserProvider({
    userId,
    provider,
    tracks: normalized.map((track) => ({
      sourceId: track.sourceId,
      addedAtMs: track.addedAtMs,
      title: track.title,
      artist: track.artist,
      durationMs: track.durationMs,
    })),
  });

  logEvent("info", "user_liked_library_synced", {
    userId,
    provider,
    fetchedCount: fetched.tracks.length,
    uniqueCount: normalized.length,
    savedCount: replaced.savedCount,
    providerTotal: fetched.total,
  });

  return {
    provider,
    fetchedCount: fetched.tracks.length,
    uniqueCount: normalized.length,
    savedCount: replaced.savedCount,
    providerTotal: fetched.total,
  };
}

export async function fetchUserPlaylists(
  userId: string,
  provider: MusicProvider,
  limit = 30,
): Promise<UserLibraryPlaylist[]> {
  const safeLimit = Math.max(1, Math.min(limit, 100));

  if (provider === "spotify") {
    const link = await getValidSpotifyLink(userId);
    if (!link?.accessToken) return [];

    const url = new URL("https://api.spotify.com/v1/me/playlists");
    url.searchParams.set("limit", String(Math.min(50, safeLimit)));
    const payload = (await fetchJsonWithTimeout(
      url,
      {
        headers: {
          authorization: `Bearer ${link.accessToken}`,
        },
      },
      {
        timeoutMs: 6_000,
        retries: 1,
        context: {
          provider: "spotify",
          route: "user_playlists",
        },
      },
    )) as SpotifyPlaylistsPayload | null;

    const playlists: UserLibraryPlaylist[] = [];
    for (const item of payload?.items ?? []) {
      const id = item.id?.trim() ?? "";
      const name = item.name?.trim() ?? "";
      if (!id || !name) continue;
      playlists.push({
        provider: "spotify",
        id,
        name,
        description: item.description?.trim() ?? "",
        imageUrl: item.images?.[0]?.url?.trim() || null,
        externalUrl: item.external_urls?.spotify ?? `https://open.spotify.com/playlist/${id}`,
        owner: item.owner?.display_name?.trim() ?? null,
        trackCount:
          typeof item.tracks?.total === "number" && Number.isFinite(item.tracks.total)
            ? item.tracks.total
            : null,
        sourceQuery: `spotify:playlist:${id}`,
      });
      if (playlists.length >= safeLimit) break;
    }
    return playlists;
  }

  const link = await musicAccountRepository.getLink(userId, "deezer");
  if (!link?.accessToken) return [];
  const url = new URL("https://api.deezer.com/user/me/playlists");
  url.searchParams.set("access_token", link.accessToken);
  url.searchParams.set("limit", String(Math.min(50, safeLimit)));
  const payload = (await fetchJsonWithTimeout(
    url,
    {},
    {
      timeoutMs: 6_000,
      retries: 1,
      context: {
        provider: "deezer",
        route: "user_playlists",
      },
    },
  )) as DeezerPlaylistsPayload | null;
  const playlists: UserLibraryPlaylist[] = [];
  for (const item of payload?.data ?? []) {
    const id = typeof item.id === "number" ? String(item.id) : "";
    const name = item.title?.trim() ?? "";
    if (!id || !name) continue;
    playlists.push({
      provider: "deezer",
      id,
      name,
      description: item.description?.trim() ?? "",
      imageUrl: item.picture_medium?.trim() || null,
      externalUrl: item.link?.trim() || `https://www.deezer.com/playlist/${id}`,
      owner: item.creator?.name?.trim() ?? null,
      trackCount:
        typeof item.nb_tracks === "number" && Number.isFinite(item.nb_tracks)
          ? item.nb_tracks
          : null,
      sourceQuery: `deezer:playlist:${id}`,
    });
    if (playlists.length >= safeLimit) break;
  }
  return playlists;
}
