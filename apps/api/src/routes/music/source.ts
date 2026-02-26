import { Elysia } from "elysia";
import { fetchAniListUserAnimeTitles } from "./anilist";
import { searchDeezerPlaylists } from "./deezer";
import { parseTrackSource, resolveTrackPoolFromSource } from "../../services/TrackSourceResolver";
import { logEvent } from "../../lib/logger";
import { readEnvVar } from "../../lib/env";

function parseLimit(raw: string | undefined, fallback: number) {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, parsed);
}

function parseUsers(raw: string | undefined) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

type UnifiedPlaylistOption = {
  provider: "deezer";
  id: string;
  name: string;
  description: string;
  imageUrl: string | null;
  externalUrl: string;
  owner: string | null;
  trackCount: number | null;
  sourceQuery: string;
};

function normalizeTrackCount(raw: unknown) {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return null;
}

function toUnifiedPlaylistOption(
  provider: "deezer",
  raw: unknown,
): UnifiedPlaylistOption | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!id || !name) return null;
  const description = typeof input.description === "string" ? input.description : "";
  const imageUrl = typeof input.imageUrl === "string" && input.imageUrl.trim().length > 0
    ? input.imageUrl
    : null;
  const externalUrl = typeof input.externalUrl === "string" && input.externalUrl.trim().length > 0
    ? input.externalUrl
    : `https://www.deezer.com/playlist/${id}`;
  const owner = typeof input.owner === "string" && input.owner.trim().length > 0 ? input.owner : null;
  const trackCount = normalizeTrackCount(input.trackCount);
  return {
    provider,
    id,
    name,
    description,
    imageUrl,
    externalUrl,
    owner,
    trackCount,
    sourceQuery: `${provider}:playlist:${id}`,
  };
}

function playlistWeight(item: UnifiedPlaylistOption) {
  let score = item.trackCount ?? 0;
  const owner = (item.owner ?? "").toLowerCase();
  const name = item.name.toLowerCase();
  if (item.provider === "deezer" && owner.includes("deezer")) score += 120;
  if (name.includes("top") || name.includes("hits") || name.includes("viral")) score += 40;
  if (item.imageUrl) score += 15;
  return score;
}

const DEFAULT_PLAYLIST_SEARCH_PROVIDER_TIMEOUT_MS = 2_500;

function readPlaylistSearchProviderTimeoutMs() {
  const raw = readEnvVar("PLAYLIST_SEARCH_PROVIDER_TIMEOUT_MS");
  if (!raw) return DEFAULT_PLAYLIST_SEARCH_PROVIDER_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PLAYLIST_SEARCH_PROVIDER_TIMEOUT_MS;
  return Math.max(200, Math.min(parsed, 10_000));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutCode: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutCode));
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

function readSettledErrorMessage(value: PromiseSettledResult<unknown>) {
  if (value.status !== "rejected") return null;
  if (value.reason instanceof Error) return value.reason.message;
  if (typeof value.reason === "string" && value.reason.trim().length > 0) return value.reason;
  return "UNKNOWN_ERROR";
}

export const musicSourceRoutes = new Elysia({ prefix: "/music" })
  .get("/source/resolve", async ({ query, set }) => {
    const source = typeof query.source === "string" ? query.source.trim() : "";
    if (!source) {
      set.status = 400;
      return { error: "MISSING_SOURCE" };
    }

    const size = parseLimit(typeof query.size === "string" ? query.size : undefined, 12);
    const parsed = parseTrackSource(source);
    try {
      const tracks = await resolveTrackPoolFromSource({
        categoryQuery: source,
        size,
      });
      const previewCount = tracks.filter(
        (track) => typeof track.previewUrl === "string" && track.previewUrl.trim().length > 0,
      ).length;

      return {
        ok: true as const,
        source,
        parsed,
        count: tracks.length,
        previewCount,
        withoutPreviewCount: Math.max(0, tracks.length - previewCount),
        tracks,
      };
    } catch (error) {
      logEvent("warn", "music_source_resolve_failed", {
        source,
        size,
        parsedType: parsed.type,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      });
      return {
        ok: true as const,
        source,
        parsed,
        count: 0,
        previewCount: 0,
        withoutPreviewCount: 0,
        tracks: [],
      };
    }
  })
  .get("/playlists/search", async ({ query, set }) => {
    const limit = parseLimit(typeof query.limit === "string" ? query.limit : undefined, 24);
    const raw = typeof query.q === "string" ? query.q.trim() : "";
    if (raw.length < 2) {
      set.status = 400;
      return { error: "MISSING_QUERY" };
    }

    const providerTimeoutMs = readPlaylistSearchProviderTimeoutMs();
    const deezerResult = await Promise.allSettled([
      withTimeout(
        searchDeezerPlaylists(raw, limit),
        providerTimeoutMs,
        "DEEZER_PLAYLIST_SEARCH_TIMEOUT",
      ),
    ]).then((entries) => entries[0]);
    const deezerRaw = deezerResult.status === "fulfilled" ? (deezerResult.value as unknown) : null;
    const deezer = Array.isArray(deezerRaw) ? deezerRaw : [];
    logEvent("info", "playlist_search_provider_payload", {
      q: raw,
      limit,
      deezerStatus: deezerResult.status,
      deezerType: Array.isArray(deezerRaw) ? "array" : typeof deezerRaw,
      deezerCount: deezer.length,
      deezerFirst: deezer[0]
        ? {
            id: deezer[0].id,
            name: deezer[0].name,
            trackCount: deezer[0].trackCount ?? null,
          }
        : null,
    });
    if (deezerResult.status === "rejected") {
      logEvent("warn", "playlist_search_partial_failure", {
        q: raw,
        limit,
        providerTimeoutMs,
        deezerFailed: deezerResult.status === "rejected",
        deezerError: readSettledErrorMessage(deezerResult),
      });
    }

    const merged: UnifiedPlaylistOption[] = deezer
      .map((item) => toUnifiedPlaylistOption("deezer", item))
      .filter((item) => item !== null);

    const deduped: UnifiedPlaylistOption[] = [];
    const seen = new Set<string>();
    for (const playlist of merged.sort((a, b) => playlistWeight(b) - playlistWeight(a))) {
      const key = `${playlist.provider}:${playlist.id}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(playlist);
      if (deduped.length >= limit) break;
    }
    logEvent("info", "playlist_search_response_payload", {
      q: raw,
      limit,
      mergedCount: merged.length,
      returnedCount: deduped.length,
      firstReturned: deduped[0]
        ? {
            provider: deduped[0].provider,
            id: deduped[0].id,
            name: deduped[0].name,
            trackCount: deduped[0].trackCount ?? null,
          }
        : null,
    });

    return {
      ok: true as const,
      q: raw,
      playlists: deduped,
    };
  })
  .get("/anilist/titles", async ({ query, set }) => {
    const users = parseUsers(typeof query.users === "string" ? query.users : undefined).slice(0, 8);
    if (users.length === 0) {
      set.status = 400;
      return { error: "MISSING_USERS" };
    }

    const limit = parseLimit(typeof query.limit === "string" ? query.limit : undefined, 60);
    const byUser = await Promise.all(
      users.map(async (user) => ({
        user,
        titles: await fetchAniListUserAnimeTitles(user, limit),
      })),
    );

    return {
      ok: true as const,
      users,
      byUser,
    };
  });
