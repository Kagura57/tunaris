import { fetchJsonWithTimeout } from "./http";
import { logEvent } from "../../lib/logger";
import type { MusicTrack } from "../../services/music-types";
import { readEnvVar } from "../../lib/env";

type YouTubePayload = {
  items?: Array<{
    id?: { videoId?: string } | string;
    snippet?: {
      title?: string;
      channelTitle?: string;
    };
  }>;
};

type YouTubeOEmbedPayload = {
  title?: string;
  author_name?: string;
};

type InvidiousSearchItem = {
  type?: string;
  videoId?: string;
  title?: string;
  author?: string;
  uploader?: string;
};

type HttpErrorDetails = {
  status: number;
  errorDetail: string | null;
};

type ApiKeyAttemptDiagnostic = {
  keyRef: string;
  status: number | null;
  errorDetail: string | null;
  payloadReceived: boolean;
  itemCount: number;
};

type InvidiousAttemptDiagnostic = {
  instance: string;
  status: number | null;
  errorDetail: string | null;
  payloadType: "array" | "null" | "other";
  trackCount: number;
};

type InvidiousSearchResult = {
  tracks: MusicTrack[];
  attempts: InvidiousAttemptDiagnostic[];
  usedDefaultInstances: boolean;
};

type WebSearchResult = {
  tracks: MusicTrack[];
  htmlStatus: number | null;
  htmlError: string | null;
  parsedVideoIdCount: number;
  oembedAttempts: number;
  oembedSuccesses: number;
  oembedErrorCount: number;
  firstOembedError: string | null;
};

type YTMusicSearchResult = {
  tracks: MusicTrack[];
  attempted: boolean;
  urlHost: string | null;
  status: number | null;
  errorDetail: string | null;
};

const YOUTUBE_FAILURE_BACKOFF_MS = 60_000;
const YOUTUBE_KEY_COOLDOWN_MS = 30 * 60_000;
const YOUTUBE_FALLBACK_BACKOFF_MS = 5 * 60_000;
const YOUTUBE_QUERY_CACHE_TTL_MS = 6 * 60 * 60_000;
const YOUTUBE_QUERY_MISS_CACHE_TTL_MS = 90_000;
const YOUTUBE_INVIDIOUS_TIMEOUT_MS = 2_500;
const YOUTUBE_WEB_SEARCH_TIMEOUT_MS = 3_500;
const YOUTUBE_OEMBED_TIMEOUT_MS = 2_500;
const YOUTUBE_WEB_MAX_IDS = 20;
const DEFAULT_INVIDIOUS_INSTANCES = [
  "https://yewtu.be",
  "https://inv.nadeko.net",
  "https://invidious.fdn.fr",
];

let youtubeSearchBackoffUntilMs = 0;
let youtubeFallbackBackoffUntilMs = 0;
let youtubeKeyRotationIndex = 0;
let youtubeInvidiousRotationIndex = 0;
const youtubeKeyCooldownUntilMs = new Map<string, number>();
const youtubeQueryCache = new Map<
  string,
  {
    tracks: MusicTrack[];
    expiresAt: number;
  }
>();

export function resetYouTubeSearchBackoffForTests() {
  youtubeSearchBackoffUntilMs = 0;
  youtubeFallbackBackoffUntilMs = 0;
  youtubeKeyRotationIndex = 0;
  youtubeInvidiousRotationIndex = 0;
  youtubeKeyCooldownUntilMs.clear();
  youtubeQueryCache.clear();
}

function readYouTubeApiKeys() {
  const fromList = (readEnvVar("YOUTUBE_API_KEYS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const candidates = [
    ...fromList,
    readEnvVar("YOUTUBE_API_KEY"),
    readEnvVar("GOOGLE_API_KEY"),
    readEnvVar("YT_API_KEY"),
  ];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function cacheKey(query: string, safeLimit: number) {
  return `${query.trim().toLowerCase()}::${safeLimit}`;
}

function readCachedQuery(query: string, safeLimit: number) {
  const key = cacheKey(query, safeLimit);
  const cached = youtubeQueryCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    youtubeQueryCache.delete(key);
    return null;
  }
  return cached.tracks.slice(0, safeLimit);
}

function writeCachedQuery(query: string, safeLimit: number, tracks: MusicTrack[], ttlMs = YOUTUBE_QUERY_CACHE_TTL_MS) {
  youtubeQueryCache.set(cacheKey(query, safeLimit), {
    tracks: tracks.slice(0, safeLimit),
    expiresAt: Date.now() + ttlMs,
  });
}

function orderedKeysForAttempt(keys: string[]) {
  if (keys.length <= 1) return keys;
  const start = youtubeKeyRotationIndex % keys.length;
  return [...keys.slice(start), ...keys.slice(0, start)];
}

function redactApiKey(key: string) {
  const value = key.trim();
  if (value.length <= 6) return "[redacted]";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function isQuotaErrorDetail(errorDetail: string | null) {
  if (!errorDetail) return false;
  const normalized = errorDetail.toLowerCase();
  return normalized.includes("quota");
}

function normalizeBaseUrl(raw: string) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    const normalized = `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`.replace(/\/+$/, "");
    return normalized.length > 0 ? normalized : parsed.origin;
  } catch {
    return null;
  }
}

function readConfiguredInvidiousInstances() {
  const configured = (readEnvVar("YOUTUBE_INVIDIOUS_INSTANCES") ?? "")
    .split(",")
    .map((value) => normalizeBaseUrl(value))
    .filter((value): value is string => Boolean(value));
  return configured;
}

function readInvidiousInstances(useDefaults: boolean) {
  const configured = readConfiguredInvidiousInstances();
  const candidates = configured.length > 0 ? configured : useDefaults ? DEFAULT_INVIDIOUS_INSTANCES : [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
}

function orderedInstancesForAttempt(instances: string[]) {
  if (instances.length <= 1) return instances;
  const start = youtubeInvidiousRotationIndex % instances.length;
  return [...instances.slice(start), ...instances.slice(0, start)];
}

function readYtMusicSearchUrl() {
  const raw = readEnvVar("YTMUSIC_SEARCH_URL");
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readStringValue(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractVideoId(raw: string) {
  const trimmed = raw.trim();
  if (trimmed.length <= 0) return null;

  const fromQuery = trimmed.match(/[?&]v=([a-zA-Z0-9_-]+)/)?.[1];
  if (fromQuery) return fromQuery;

  try {
    const parsed = new URL(trimmed);
    const fromUrlQuery = parsed.searchParams.get("v")?.trim();
    if (fromUrlQuery && fromUrlQuery.length > 0) return fromUrlQuery;
    const segments = parsed.pathname
      .split("/")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const tail = segments[segments.length - 1];
    if (tail && tail.toLowerCase() !== "watch") return tail;
  } catch {
    // Keep plain-id fallback.
  }

  if (/^[a-zA-Z0-9_-]{6,}$/.test(trimmed)) return trimmed;
  return null;
}

function readArtistFromEndpointItem(item: Record<string, unknown>) {
  const direct =
    readStringValue(item.artist) ??
    readStringValue(item.author) ??
    readStringValue(item.channelTitle) ??
    readStringValue(item.channel) ??
    readStringValue(item.uploader);
  if (direct) return direct;

  const artists = item.artists;
  if (!Array.isArray(artists)) return null;

  for (const candidate of artists) {
    const asString = readStringValue(candidate);
    if (asString) return asString;
    if (!candidate || typeof candidate !== "object") continue;
    const named = readStringValue((candidate as Record<string, unknown>).name);
    if (named) return named;
  }
  return null;
}

function readTrackItemsFromYtMusicPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.tracks)) return record.tracks;
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.results)) return record.results;
  return [];
}

function parseYtMusicEndpointTracks(payload: unknown, fallbackTitle: string): MusicTrack[] {
  const rawItems = readTrackItemsFromYtMusicPayload(payload);
  const tracks: MusicTrack[] = [];

  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    const idCandidate =
      readStringValue(item.videoId) ??
      readStringValue(item.video_id) ??
      readStringValue(item.youtubeId) ??
      readStringValue(item.id) ??
      readStringValue(item.url) ??
      readStringValue(item.permalink);
    const id = idCandidate ? extractVideoId(idCandidate) : null;
    if (!id) continue;

    const title = readStringValue(item.title) ?? readStringValue(item.name) ?? fallbackTitle;
    const artist = readArtistFromEndpointItem(item) ?? "Unknown";
    tracks.push({
      provider: "youtube",
      id,
      title,
      artist,
      previewUrl: null,
      sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    });
  }

  return tracks;
}

function parseYouTubeVideoIdsFromHtml(html: string, limit: number) {
  const matches = html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

async function fetchTextWithTimeout(url: URL, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) {
      return {
        text: null as string | null,
        status: response.status,
        error: `HTTP_${response.status}`,
      };
    }
    return {
      text: await response.text(),
      status: response.status,
      error: null as string | null,
    };
  } catch (error) {
    return {
      text: null as string | null,
      status: null as number | null,
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function dedupeByVideoId(tracks: MusicTrack[], limit: number) {
  const seen = new Set<string>();
  const deduped: MusicTrack[] = [];
  for (const track of tracks) {
    const key = track.id.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(track);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

async function searchYouTubeViaInvidious(
  query: string,
  safeLimit: number,
  options: { allowDefaultInstances: boolean },
): Promise<InvidiousSearchResult> {
  const configuredInstances = readConfiguredInvidiousInstances();
  const usedDefaultInstances = configuredInstances.length <= 0 && options.allowDefaultInstances;
  const instances = readInvidiousInstances(options.allowDefaultInstances);
  if (instances.length <= 0) {
    return {
      tracks: [],
      attempts: [],
      usedDefaultInstances,
    };
  }

  const ordered = orderedInstancesForAttempt(instances);
  const attempts: InvidiousAttemptDiagnostic[] = [];
  for (const instance of ordered) {
    const url = new URL(`${instance}/api/v1/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("type", "video");

    let httpError: HttpErrorDetails | null = null;
    const payload = (await fetchJsonWithTimeout(url, {}, {
      timeoutMs: YOUTUBE_INVIDIOUS_TIMEOUT_MS,
      retries: 0,
      onHttpError: (details) => {
        httpError = {
          status: details.status,
          errorDetail: details.errorDetail,
        };
      },
      context: {
        provider: "youtube",
        route: "invidious_search",
        instance,
      },
    })) as InvidiousSearchItem[] | null;

    if (!Array.isArray(payload)) {
      attempts.push({
        instance,
        status: httpError?.status ?? null,
        errorDetail: httpError?.errorDetail ?? null,
        payloadType: payload === null ? "null" : "other",
        trackCount: 0,
      });
      continue;
    }

    const tracks = payload
      .map((item) => {
        const id = item.videoId?.trim();
        const title = item.title?.trim();
        const artist = item.author?.trim() || item.uploader?.trim();
        if (!id || !title || !artist) return null;
        return {
          provider: "youtube" as const,
          id,
          title,
          artist,
          previewUrl: null,
          sourceUrl: `https://www.youtube.com/watch?v=${id}`,
        };
      })
      .filter((value): value is MusicTrack => value !== null);

    attempts.push({
      instance,
      status: httpError?.status ?? null,
      errorDetail: httpError?.errorDetail ?? null,
      payloadType: "array",
      trackCount: tracks.length,
    });

    if (tracks.length > 0) {
      const usedIndex = instances.findIndex((entry) => entry === instance);
      if (usedIndex >= 0) {
        youtubeInvidiousRotationIndex = usedIndex + 1;
      }
      return {
        tracks: dedupeByVideoId(tracks, safeLimit),
        attempts,
        usedDefaultInstances,
      };
    }
  }

  return {
    tracks: [],
    attempts,
    usedDefaultInstances,
  };
}

async function searchYouTubeViaWeb(query: string, safeLimit: number): Promise<WebSearchResult> {
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", query);
  const htmlResult = await fetchTextWithTimeout(url, YOUTUBE_WEB_SEARCH_TIMEOUT_MS);
  const html = htmlResult.text;
  if (!html) {
    return {
      tracks: [],
      htmlStatus: htmlResult.status,
      htmlError: htmlResult.error,
      parsedVideoIdCount: 0,
      oembedAttempts: 0,
      oembedSuccesses: 0,
      oembedErrorCount: 0,
      firstOembedError: null,
    };
  }

  const ids = parseYouTubeVideoIdsFromHtml(html, Math.max(safeLimit * 2, YOUTUBE_WEB_MAX_IDS));
  if (ids.length <= 0) {
    return {
      tracks: [],
      htmlStatus: htmlResult.status,
      htmlError: null,
      parsedVideoIdCount: 0,
      oembedAttempts: 0,
      oembedSuccesses: 0,
      oembedErrorCount: 0,
      firstOembedError: null,
    };
  }

  const tracks: MusicTrack[] = [];
  const maxIds = Math.min(ids.length, Math.max(safeLimit * 2, safeLimit));
  let oembedAttempts = 0;
  let oembedSuccesses = 0;
  let oembedErrorCount = 0;
  let firstOembedError: string | null = null;
  for (const id of ids.slice(0, maxIds)) {
    const oembedUrl = new URL("https://www.youtube.com/oembed");
    oembedUrl.searchParams.set("url", `https://www.youtube.com/watch?v=${id}`);
    oembedUrl.searchParams.set("format", "json");

    oembedAttempts += 1;
    let httpError: HttpErrorDetails | null = null;
    const payload = (await fetchJsonWithTimeout(oembedUrl, {}, {
      timeoutMs: YOUTUBE_OEMBED_TIMEOUT_MS,
      retries: 0,
      onHttpError: (details) => {
        httpError = {
          status: details.status,
          errorDetail: details.errorDetail,
        };
      },
      context: {
        provider: "youtube",
        route: "oembed_lookup",
      },
    })) as YouTubeOEmbedPayload | null;
    if (!payload) {
      oembedErrorCount += 1;
      if (!firstOembedError) {
        firstOembedError =
          httpError
            ? `HTTP_${httpError.status}${httpError.errorDetail ? `:${httpError.errorDetail}` : ""}`
            : "EMPTY_PAYLOAD";
      }
      continue;
    }

    const title = payload?.title?.trim();
    const artist = payload?.author_name?.trim();
    if (!title || !artist) {
      oembedErrorCount += 1;
      if (!firstOembedError) firstOembedError = "MISSING_TITLE_OR_ARTIST";
      continue;
    }

    oembedSuccesses += 1;
    tracks.push({
      provider: "youtube",
      id,
      title,
      artist,
      previewUrl: null,
      sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    });

    if (tracks.length >= safeLimit) break;
  }

  if (tracks.length > 0) {
    return {
      tracks: dedupeByVideoId(tracks, safeLimit),
      htmlStatus: htmlResult.status,
      htmlError: null,
      parsedVideoIdCount: ids.length,
      oembedAttempts,
      oembedSuccesses,
      oembedErrorCount,
      firstOembedError,
    };
  }

  return {
    tracks: [],
    htmlStatus: htmlResult.status,
    htmlError: null,
    parsedVideoIdCount: ids.length,
    oembedAttempts,
    oembedSuccesses,
    oembedErrorCount,
    firstOembedError,
  };
}

async function searchYouTubeViaYtMusicEndpoint(query: string, safeLimit: number): Promise<YTMusicSearchResult> {
  const endpoint = readYtMusicSearchUrl();
  if (!endpoint) {
    return {
      tracks: [],
      attempted: false,
      urlHost: null,
      status: null,
      errorDetail: null,
    };
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    logEvent("warn", "youtube_ytmusic_endpoint_invalid", {
      rawUrl: endpoint,
    });
    return {
      tracks: [],
      attempted: false,
      urlHost: null,
      status: null,
      errorDetail: "INVALID_URL",
    };
  }
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(safeLimit));

  let httpError: HttpErrorDetails | null = null;
  const payload = await fetchJsonWithTimeout(url, {}, {
    timeoutMs: 3_500,
    retries: 0,
    onHttpError: (details) => {
      httpError = {
        status: details.status,
        errorDetail: details.errorDetail,
      };
    },
    context: {
      provider: "youtube",
      route: "ytmusic_search_bridge",
      query,
    },
  });
  if (!payload) {
    return {
      tracks: [],
      attempted: true,
      urlHost: url.host,
      status: httpError?.status ?? null,
      errorDetail: httpError?.errorDetail ?? null,
    };
  }

  const tracks = dedupeByVideoId(parseYtMusicEndpointTracks(payload, query), safeLimit);
  return {
    tracks,
    attempted: true,
    urlHost: url.host,
    status: httpError?.status ?? null,
    errorDetail: httpError?.errorDetail ?? null,
  };
}

export async function searchYouTube(query: string, limit = 10): Promise<MusicTrack[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) return [];
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const cached = readCachedQuery(normalizedQuery, safeLimit);
  if (cached) {
    logEvent("debug", "youtube_search_cache_hit", {
      query: normalizedQuery,
      limit: safeLimit,
      trackCount: cached.length,
    });
    return cached;
  }

  const apiKeys = readYouTubeApiKeys();
  const apiAttemptDiagnostics: ApiKeyAttemptDiagnostic[] = [];
  let apiReceivedResponse = false;
  let apiErrorCount = 0;
  let apiQuotaErrorCount = 0;
  let keysSkippedByCooldown = 0;
  const apiBackoffActiveAtStart = youtubeSearchBackoffUntilMs > Date.now();
  if (apiKeys.length > 0 && youtubeSearchBackoffUntilMs <= Date.now()) {
    const now = Date.now();
    const keysToTry = orderedKeysForAttempt(apiKeys).filter((key) => {
      const cooldown = youtubeKeyCooldownUntilMs.get(key) ?? 0;
      return cooldown <= now;
    });
    keysSkippedByCooldown = Math.max(0, apiKeys.length - keysToTry.length);

    for (const apiKey of keysToTry) {
      const url = new URL("https://www.googleapis.com/youtube/v3/search");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("type", "video");
      url.searchParams.set("maxResults", String(safeLimit));
      url.searchParams.set("q", normalizedQuery);
      url.searchParams.set("key", apiKey);

      let httpError: HttpErrorDetails | null = null;
      const payload = (await fetchJsonWithTimeout(
        url,
        {},
        {
          timeoutMs: 3_500,
          retries: 0,
          onHttpError: (details) => {
            httpError = {
              status: details.status,
              errorDetail: details.errorDetail,
            };
          },
          context: {
            provider: "youtube",
            query: normalizedQuery,
          },
        },
      )) as YouTubePayload | null;

      if (!payload) {
        apiErrorCount += 1;
        if (isQuotaErrorDetail(httpError?.errorDetail ?? null)) {
          apiQuotaErrorCount += 1;
        }
        apiAttemptDiagnostics.push({
          keyRef: redactApiKey(apiKey),
          status: httpError?.status ?? null,
          errorDetail: httpError?.errorDetail ?? null,
          payloadReceived: false,
          itemCount: 0,
        });
        youtubeKeyCooldownUntilMs.set(apiKey, Date.now() + YOUTUBE_KEY_COOLDOWN_MS);
        continue;
      }

      apiReceivedResponse = true;
      youtubeSearchBackoffUntilMs = 0;
      const items = payload.items ?? [];
      const parsedTracks = items
        .map((item) => {
          const id =
            (typeof item.id === "string" ? item.id : item.id?.videoId)?.trim() ?? "";
          if (!id) return null;
          return {
            provider: "youtube" as const,
            id,
            title: item.snippet?.title?.trim() || normalizedQuery,
            artist: item.snippet?.channelTitle?.trim() || "Unknown",
            previewUrl: null,
            sourceUrl: `https://www.youtube.com/watch?v=${id}`,
          } satisfies MusicTrack;
        })
        .filter((value): value is MusicTrack => value !== null);
      apiAttemptDiagnostics.push({
        keyRef: redactApiKey(apiKey),
        status: httpError?.status ?? null,
        errorDetail: httpError?.errorDetail ?? null,
        payloadReceived: true,
        itemCount: parsedTracks.length,
      });

      const usedIndex = apiKeys.findIndex((value) => value === apiKey);
      if (usedIndex >= 0) {
        youtubeKeyRotationIndex = usedIndex + 1;
      }

      if (parsedTracks.length > 0) {
        const firstTrack = [parsedTracks[0] as MusicTrack];
        writeCachedQuery(normalizedQuery, safeLimit, firstTrack);
        logEvent("info", "youtube_search_success", {
          query: normalizedQuery,
          limit: safeLimit,
          source: "youtube_data_api",
          trackCount: firstTrack.length,
          selectedKey: redactApiKey(apiKey),
          apiAttemptCount: apiAttemptDiagnostics.length,
          apiKeysConfigured: apiKeys.length,
        });
        return firstTrack;
      }
    }
  }

  const ytmusicResult = await searchYouTubeViaYtMusicEndpoint(normalizedQuery, safeLimit);
  if (ytmusicResult.tracks.length > 0) {
    youtubeFallbackBackoffUntilMs = 0;
    writeCachedQuery(normalizedQuery, safeLimit, ytmusicResult.tracks);
    logEvent("info", "youtube_search_success", {
      query: normalizedQuery,
      limit: safeLimit,
      source: "ytmusic_endpoint",
      trackCount: ytmusicResult.tracks.length,
      endpointHost: ytmusicResult.urlHost,
      ytmusicStatus: ytmusicResult.status,
    });
    return ytmusicResult.tracks;
  }

  const configuredInvidiousInstances = readConfiguredInvidiousInstances();
  const allKeysCoolingDown = apiKeys.length > 0 && keysSkippedByCooldown >= apiKeys.length;
  const apiKeysUnavailable =
    apiKeys.length > 0 && (apiBackoffActiveAtStart || apiErrorCount > 0 || allKeysCoolingDown);
  const allowDefaultInvidious = apiKeys.length <= 0 || apiKeysUnavailable;
  let invidiousResult: InvidiousSearchResult | null = null;
  let webResult: WebSearchResult | null = null;
  if (youtubeFallbackBackoffUntilMs <= Date.now()) {
    invidiousResult = await searchYouTubeViaInvidious(normalizedQuery, safeLimit, {
      allowDefaultInstances: allowDefaultInvidious,
    });
    if (invidiousResult.tracks.length > 0) {
      youtubeFallbackBackoffUntilMs = 0;
      writeCachedQuery(normalizedQuery, safeLimit, invidiousResult.tracks);
      logEvent("info", "youtube_search_success", {
        query: normalizedQuery,
        limit: safeLimit,
        source: "invidious",
        trackCount: invidiousResult.tracks.length,
        invidiousAttemptCount: invidiousResult.attempts.length,
        invidiousUsedDefaultInstances: invidiousResult.usedDefaultInstances,
      });
      return invidiousResult.tracks;
    }

    webResult = await searchYouTubeViaWeb(normalizedQuery, safeLimit);
    if (webResult.tracks.length > 0) {
      youtubeFallbackBackoffUntilMs = 0;
      writeCachedQuery(normalizedQuery, safeLimit, webResult.tracks);
      logEvent("info", "youtube_search_success", {
        query: normalizedQuery,
        limit: safeLimit,
        source: "youtube_web_oembed",
        trackCount: webResult.tracks.length,
        webParsedVideoIdCount: webResult.parsedVideoIdCount,
        webOembedAttempts: webResult.oembedAttempts,
        webOembedSuccesses: webResult.oembedSuccesses,
      });
      return webResult.tracks;
    }

    if (configuredInvidiousInstances.length > 0 || allowDefaultInvidious) {
      youtubeFallbackBackoffUntilMs = Date.now() + YOUTUBE_FALLBACK_BACKOFF_MS;
    }
  }

  if (apiKeys.length > 0 && !apiReceivedResponse) {
    youtubeSearchBackoffUntilMs = Date.now() + YOUTUBE_FAILURE_BACKOFF_MS;
  }

  writeCachedQuery(normalizedQuery, safeLimit, [], YOUTUBE_QUERY_MISS_CACHE_TTL_MS);
  logEvent("warn", "youtube_search_empty", {
    query: normalizedQuery,
    limit: safeLimit,
    apiKeysConfigured: apiKeys.length,
    apiBackoffActiveAtStart,
    apiBackoffUntilMs: youtubeSearchBackoffUntilMs,
    keysSkippedByCooldown,
    apiReceivedResponse,
    apiErrorCount,
    apiQuotaErrorCount,
    apiAttempts: apiAttemptDiagnostics.slice(0, 5),
    ytmusicAttempted: ytmusicResult.attempted,
    ytmusicHost: ytmusicResult.urlHost,
    ytmusicStatus: ytmusicResult.status,
    ytmusicErrorDetail: ytmusicResult.errorDetail,
    ytmusicTrackCount: ytmusicResult.tracks.length,
    allowDefaultInvidious,
    configuredInvidiousInstanceCount: configuredInvidiousInstances.length,
    invidiousUsedDefaultInstances: invidiousResult?.usedDefaultInstances ?? false,
    invidiousTrackCount: invidiousResult?.tracks.length ?? 0,
    invidiousAttempts:
      invidiousResult?.attempts.slice(0, 5).map((attempt) => ({
        instance: attempt.instance,
        status: attempt.status,
        errorDetail: attempt.errorDetail,
        payloadType: attempt.payloadType,
        trackCount: attempt.trackCount,
      })) ?? [],
    webHtmlStatus: webResult?.htmlStatus ?? null,
    webHtmlError: webResult?.htmlError ?? null,
    webParsedVideoIdCount: webResult?.parsedVideoIdCount ?? 0,
    webOembedAttempts: webResult?.oembedAttempts ?? 0,
    webOembedSuccesses: webResult?.oembedSuccesses ?? 0,
    webOembedErrorCount: webResult?.oembedErrorCount ?? 0,
    webFirstOembedError: webResult?.firstOembedError ?? null,
    fallbackBackoffUntilMs: youtubeFallbackBackoffUntilMs,
  });
  return [];
}
