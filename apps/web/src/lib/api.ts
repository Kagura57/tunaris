import { logClientEvent } from "./logger";
const ENV_API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() ?? "";
let preferredApiBaseUrl: string | null = null;

function normalizeApiBaseUrl(raw: string) {
  return raw.trim().replace(/\/+$/, "");
}

function apiBaseCandidates() {
  const candidates: string[] = [];
  if (preferredApiBaseUrl) {
    candidates.push(preferredApiBaseUrl);
  }

  if (ENV_API_BASE_URL.length > 0) {
    candidates.push(ENV_API_BASE_URL);
  } else if (typeof window !== "undefined" && window.location.origin.length > 0) {
    candidates.push(`${window.location.origin}/api`);
    candidates.push(window.location.origin);
  }

  candidates.push("http://127.0.0.1:3001");
  candidates.push("http://localhost:3001");

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of candidates) {
    const normalized = normalizeApiBaseUrl(value);
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

type ApiErrorPayload = {
  error?: unknown;
};

export type RoomState = {
  roomCode: string;
  state: "waiting" | "countdown" | "playing" | "reveal" | "leaderboard" | "results";
  round: number;
  mode: "mcq" | "text" | null;
  choices: string[] | null;
  serverNowMs: number;
  playerCount: number;
  poolSize: number;
  categoryQuery: string;
  totalRounds: number;
  deadlineMs: number | null;
  previewUrl: string | null;
  media: {
    provider: "spotify" | "deezer" | "apple-music" | "tidal" | "ytmusic" | "youtube";
    trackId: string;
    sourceUrl: string | null;
    embedUrl: string | null;
  } | null;
  reveal: {
    round: number;
    trackId: string;
    provider: "spotify" | "deezer" | "apple-music" | "tidal" | "ytmusic" | "youtube";
    title: string;
    artist: string;
    acceptedAnswer: string;
    mode: "mcq" | "text";
    previewUrl: string | null;
    sourceUrl: string | null;
    embedUrl: string | null;
  } | null;
  leaderboard: Array<{
    rank: number;
    playerId: string;
    displayName: string;
    score: number;
    maxStreak: number;
  }> | null;
};

export type RoomResults = {
  roomCode: string;
  categoryQuery: string;
  state: "waiting" | "countdown" | "playing" | "reveal" | "leaderboard" | "results";
  round: number;
  ranking: Array<{
    rank: number;
    playerId: string;
    userId: string | null;
    displayName: string;
    score: number;
    maxStreak: number;
    averageResponseMs: number | null;
  }>;
};

export type RealtimeRoomSnapshot = {
  ok: true;
  roomCode: string;
  snapshot: RoomState;
  serverNowMs: number;
};

export type PublicRoomSummary = {
  roomCode: string;
  isPublic: boolean;
  state: "waiting" | "countdown" | "playing" | "reveal" | "leaderboard" | "results";
  round: number;
  totalRounds: number;
  playerCount: number;
  categoryQuery: string;
  createdAtMs: number;
  canJoin: boolean;
  deadlineMs: number | null;
  serverNowMs: number;
};

export type SpotifyPlaylistCategory = {
  id: string;
  label: string;
  query: string;
};

export type SpotifyPlaylistOption = {
  id: string;
  name: string;
  description: string;
  imageUrl: string | null;
  externalUrl: string;
  owner: string | null;
  trackCount: number | null;
};

export type UnifiedPlaylistOption = {
  provider: "spotify" | "deezer";
  id: string;
  name: string;
  description: string;
  imageUrl: string | null;
  externalUrl: string;
  owner: string | null;
  trackCount: number | null;
  sourceQuery: string;
};

type RequestOptions = RequestInit & {
  retry?: number;
};

function shouldRetry(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function readRetryCount(method: string, retry?: number) {
  if (typeof retry === "number") return Math.max(0, retry);
  return method === "GET" ? 2 : 0;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createRequestId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function requestJson<T>(path: string, init?: RequestOptions): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const retries = readRetryCount(method, init?.retry);
  const { retry: _retry, ...requestInit } = init ?? {};
  const requestId = createRequestId();
  const pathWithSlash = path.startsWith("/") ? path : `/${path}`;
  const baseCandidates = apiBaseCandidates();
  let lastError: Error | null = null;

  for (const [baseIndex, base] of baseCandidates.entries()) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(`${base}${pathWithSlash}`, {
          credentials: "include",
          ...requestInit,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
            ...(requestInit.headers ?? {}),
          },
        });

        const correlatedRequestId = response.headers.get("x-request-id") ?? requestId;

        if (response.ok) {
          preferredApiBaseUrl = base;
          return (await response.json()) as T;
        }

        if (attempt < retries && shouldRetry(response.status)) {
          logClientEvent("warn", "api_retry", {
            requestId: correlatedRequestId,
            base,
            path,
            method,
            status: response.status,
            attempt: attempt + 1,
            retries: retries + 1,
          });
          await sleep(200 * 2 ** attempt + Math.floor(Math.random() * 50));
          continue;
        }

        let details = `HTTP_${response.status}`;
        try {
          const payload = (await response.json()) as ApiErrorPayload;
          if (typeof payload.error === "string" && payload.error.length > 0) {
            details = payload.error;
          }
        } catch {
          // Ignore payload parsing failures for non-json error responses.
        }

        const shouldTryNextBase = response.status === 404 && baseIndex < baseCandidates.length - 1;
        if (shouldTryNextBase) {
          logClientEvent("warn", "api_base_fallback_not_found", {
            requestId: correlatedRequestId,
            base,
            path,
            method,
            status: response.status,
          });
          break;
        }

        logClientEvent("error", "api_request_failed", {
          requestId: correlatedRequestId,
          base,
          path,
          method,
          status: response.status,
          error: details,
          attempts: attempt + 1,
        });
        throw new Error(details);
      } catch (error) {
        const message = error instanceof Error ? error.message : "HTTP_UNKNOWN";
        lastError = error instanceof Error ? error : new Error(message);

        if (attempt < retries) {
          logClientEvent("warn", "api_retry_network", {
            requestId,
            base,
            path,
            method,
            attempt: attempt + 1,
            retries: retries + 1,
            error: message,
          });
          await sleep(200 * 2 ** attempt + Math.floor(Math.random() * 50));
          continue;
        }

        logClientEvent("warn", "api_base_unreachable", {
          requestId,
          base,
          path,
          method,
          error: message,
        });
      }
    }
  }

  logClientEvent("error", "api_request_failed", {
    requestId,
    path,
    method,
    error: lastError?.message ?? "HTTP_UNKNOWN",
    attempts: retries + 1,
    baseCandidates,
  });
  throw new Error(lastError?.message ?? "HTTP_UNKNOWN");
}

export async function createRoom(input?: { categoryQuery?: string; isPublic?: boolean }) {
  return requestJson<{ roomCode: string }>("/quiz/create", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function joinRoom(input: { roomCode: string; displayName: string }) {
  return requestJson<{ ok: true; playerId: string; playerCount: number }>("/quiz/join", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getPublicRooms() {
  return requestJson<{
    ok: true;
    serverNowMs: number;
    rooms: PublicRoomSummary[];
  }>("/quiz/public");
}

export async function startRoom(input: { roomCode: string; categoryQuery?: string }) {
  return requestJson<{
    ok: true;
    state: string;
    poolSize: number;
    categoryQuery: string;
    totalRounds: number;
    deadlineMs: number | null;
  }>("/quiz/start", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function submitRoomAnswer(input: {
  roomCode: string;
  playerId: string;
  answer: string;
}) {
  return requestJson<{ accepted: boolean }>("/quiz/answer", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getRoomState(roomCode: string) {
  return requestJson<RoomState>(`/room/${encodeURIComponent(roomCode)}/state`);
}

export async function getRealtimeSnapshot(roomCode: string) {
  return requestJson<RealtimeRoomSnapshot>(`/realtime/room/${encodeURIComponent(roomCode)}`);
}

export async function getRoomResults(roomCode: string) {
  return requestJson<RoomResults>(`/quiz/results/${encodeURIComponent(roomCode)}`);
}

export async function getAccountMe() {
  return requestJson<{
    ok: true;
    user: { id: string; name: string; email: string };
  }>("/account/me");
}

export async function getAccountHistory() {
  return requestJson<{
    ok: true;
    history: {
      stats: {
        matchesPlayed: number;
        top1Count: number;
        bestStreak: number;
      };
      matches: Array<{
        id: string;
        roomCode: string;
        categoryQuery: string;
        finishedAtMs: number;
      }>;
    };
  }>("/account/history");
}

export async function getSpotifyPlaylistCategories() {
  return requestJson<{
    ok: true;
    categories: SpotifyPlaylistCategory[];
  }>("/music/spotify/categories");
}

export async function getSpotifyPlaylists(input?: { category?: string; q?: string; limit?: number }) {
  const params = new URLSearchParams();
  if (input?.category) params.set("category", input.category);
  if (input?.q) params.set("q", input.q);
  if (typeof input?.limit === "number") params.set("limit", String(input.limit));
  const query = params.toString();
  const path = query.length > 0 ? `/music/spotify/playlists?${query}` : "/music/spotify/playlists";
  return requestJson<{
    ok: true;
    source: "popular" | "category" | "search";
    category?: string;
    search?: string;
    playlists: SpotifyPlaylistOption[];
  }>(path);
}

export async function searchPlaylistsAcrossProviders(input: { q: string; limit?: number }) {
  const params = new URLSearchParams();
  params.set("q", input.q.trim());
  if (typeof input.limit === "number") {
    params.set("limit", String(input.limit));
  }
  return requestJson<{
    ok: true;
    q: string;
    playlists: UnifiedPlaylistOption[];
  }>(`/music/playlists/search?${params.toString()}`);
}
