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
  message?: unknown;
  retryAfterMs?: unknown;
};

export class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export type RoomState = {
  roomCode: string;
  state: "waiting" | "countdown" | "playing" | "reveal" | "leaderboard" | "results";
  round: number;
  mode: "mcq" | "text" | null;
  choices: string[] | null;
  serverNowMs: number;
  playerCount: number;
  hostPlayerId: string | null;
  players: Array<{
    playerId: string;
    displayName: string;
    isReady: boolean;
    isHost: boolean;
    canContributeLibrary: boolean;
    libraryContribution: {
      includeInPool: {
        spotify: boolean;
        deezer: boolean;
      };
      linkedProviders: {
        spotify: "linked" | "not_linked" | "expired";
        deezer: "linked" | "not_linked" | "expired";
      };
      estimatedTrackCount: {
        spotify: number | null;
        deezer: number | null;
      };
      syncStatus: "idle" | "syncing" | "ready" | "error";
      lastError: string | null;
    };
  }>;
  readyCount: number;
  allReady: boolean;
  canStart: boolean;
  isResolvingTracks: boolean;
  poolSize: number;
  categoryQuery: string;
  sourceMode: "public_playlist" | "players_liked";
  sourceConfig: {
    mode: "public_playlist" | "players_liked";
    publicPlaylist: {
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
  };
  poolBuild: {
    status: "idle" | "building" | "ready" | "failed";
    contributorsCount: number;
    mergedTracksCount: number;
    playableTracksCount: number;
    lastBuiltAtMs: number | null;
    errorCode: string | null;
  };
  totalRounds: number;
  deadlineMs: number | null;
  previewUrl: string | null;
  media: {
    provider: "spotify" | "deezer" | "apple-music" | "tidal" | "youtube";
    trackId: string;
    sourceUrl: string | null;
    embedUrl: string | null;
  } | null;
  reveal: {
    round: number;
    trackId: string;
    provider: "spotify" | "deezer" | "apple-music" | "tidal" | "youtube";
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

export type UnifiedPlaylistOption = {
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
        const headers = new Headers(requestInit.headers ?? undefined);
        const hasBody = typeof requestInit.body !== "undefined" && requestInit.body !== null;
        const shouldAttachJsonContentType = hasBody && method !== "GET" && method !== "HEAD";
        if (shouldAttachJsonContentType && !headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
        // Keep GET requests as "simple requests" to avoid fragile CORS preflights in local dev.
        if (method !== "GET" && method !== "HEAD") {
          headers.set("x-request-id", requestId);
        }

        const response = await fetch(`${base}${pathWithSlash}`, {
          credentials: "include",
          ...requestInit,
          headers,
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
        let retryAfterMs: number | null = null;
        try {
          const payload = (await response.json()) as ApiErrorPayload;
          if (typeof payload.error === "string" && payload.error.length > 0) {
            details = payload.error;
          } else if (typeof payload.message === "string" && payload.message.length > 0) {
            details = payload.message;
          }
          if (typeof payload.retryAfterMs === "number" && Number.isFinite(payload.retryAfterMs)) {
            retryAfterMs = Math.max(0, Math.round(payload.retryAfterMs));
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
          retryAfterMs,
          attempts: attempt + 1,
        });
        throw new HttpStatusError(details, response.status, retryAfterMs);
      } catch (error) {
        if (error instanceof HttpStatusError) {
          logClientEvent("warn", "api_request_terminal_http_error", {
            requestId,
            base,
            path,
            method,
            status: error.status,
            error: error.message,
          });
          throw error;
        }

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
  return requestJson<{ ok: true; playerId: string; playerCount: number; hostPlayerId: string | null }>(
    "/quiz/join",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function getPublicRooms() {
  return requestJson<{
    ok: true;
    serverNowMs: number;
    rooms: PublicRoomSummary[];
  }>("/quiz/public");
}

export async function startRoom(input: { roomCode: string; playerId: string }) {
  return requestJson<{
    ok: true;
    state: string;
    poolSize: number;
    categoryQuery: string;
    sourceMode?: "public_playlist" | "players_liked";
    totalRounds: number;
    deadlineMs: number | null;
  }>("/quiz/start", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function setRoomSource(input: { roomCode: string; playerId: string; categoryQuery: string }) {
  return requestJson<{ ok: true; categoryQuery: string }>("/quiz/source", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function setRoomSourceMode(input: {
  roomCode: string;
  playerId: string;
  mode: "public_playlist" | "players_liked";
}) {
  return requestJson<{ ok: true; mode: "public_playlist" | "players_liked" }>("/quiz/source/mode", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function setRoomPublicPlaylist(input: {
  roomCode: string;
  playerId: string;
  id: string;
  name: string;
  trackCount: number | null;
  sourceQuery: string;
}) {
  return requestJson<{
    ok: true;
    sourceMode: "public_playlist" | "players_liked";
    categoryQuery: string;
  }>("/quiz/source/public-playlist", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function setPlayerLibraryContribution(input: {
  roomCode: string;
  playerId: string;
  provider: "spotify" | "deezer";
  includeInPool: boolean;
}) {
  return requestJson<{
    ok: true;
    includeInPool: boolean;
  }>("/quiz/library/contribution", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function refreshPlayerLibraryLinks(input: {
  roomCode: string;
  playerId: string;
}) {
  return requestJson<{
    ok: true;
    linkedProviders: {
      spotify: "linked" | "not_linked" | "expired";
      deezer: "linked" | "not_linked" | "expired";
    };
  }>("/quiz/library/refresh-links", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function setPlayerReady(input: { roomCode: string; playerId: string; ready: boolean }) {
  return requestJson<{ ok: true; isReady: boolean }>("/quiz/ready", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function kickPlayer(input: { roomCode: string; playerId: string; targetPlayerId: string }) {
  return requestJson<{ ok: true; playerCount: number }>("/quiz/kick", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function leaveRoom(input: { roomCode: string; playerId: string }) {
  return requestJson<{ ok: true; playerCount: number; hostPlayerId: string | null }>("/quiz/leave", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function replayRoom(input: { roomCode: string; playerId: string }) {
  return requestJson<{
    ok: true;
    roomCode: string;
    state: string;
    playerCount: number;
    categoryQuery: string;
  }>("/quiz/replay", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function skipRoomRound(input: { roomCode: string; playerId: string }) {
  return requestJson<{
    ok: true;
    state: string;
    round: number;
    deadlineMs: number | null;
  }>("/quiz/skip", {
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

export async function getAuthSession() {
  return requestJson<{
    session: {
      id: string;
      userId: string;
      expiresAt: string;
      createdAt: string;
      updatedAt: string;
    };
    user: {
      id: string;
      name: string;
      email: string;
    };
  } | null>("/auth/get-session");
}

export async function signUpWithEmail(input: {
  name: string;
  email: string;
  password: string;
  rememberMe?: boolean;
}) {
  return requestJson<{
    token: string | null;
    user: {
      id: string;
      name: string;
      email: string;
    };
  }>("/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function signInWithEmail(input: {
  email: string;
  password: string;
  rememberMe?: boolean;
}) {
  return requestJson<{
    redirect: boolean;
    token: string;
    url: string | null;
    user: {
      id: string;
      name: string;
      email: string;
    };
  }>("/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function signOutAccount() {
  return requestJson<{ success: boolean }>("/auth/sign-out", {
    method: "POST",
  });
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

export async function getMusicProviderLinks() {
  return requestJson<{
    ok: true;
    providers: {
      spotify: { status: "linked" | "not_linked" | "expired" };
      deezer: { status: "linked" | "not_linked" | "expired" };
    };
  }>("/account/music/providers");
}

export async function getMusicProviderConnectUrl(input: {
  provider: "spotify" | "deezer";
  returnTo?: string;
}) {
  const params = new URLSearchParams();
  if (input.returnTo && input.returnTo.trim().length > 0) {
    params.set("returnTo", input.returnTo.trim());
  }
  const query = params.toString();
  return requestJson<{
    ok: true;
    provider: "spotify" | "deezer";
    authorizeUrl: string;
  }>(`/account/music/${input.provider}/connect/start${query.length > 0 ? `?${query}` : ""}`);
}

export async function disconnectMusicProvider(input: { provider: "spotify" | "deezer" }) {
  return requestJson<{
    ok: true;
    providers: {
      spotify: { status: "linked" | "not_linked" | "expired" };
      deezer: { status: "linked" | "not_linked" | "expired" };
    };
  }>(`/account/music/${input.provider}/disconnect`, {
    method: "POST",
  });
}

export async function queueMySpotifyLibrarySync() {
  return requestJson<{
    ok: true;
    message: string;
    status: "accepted";
    jobId: string | null;
  }>("/music/library/sync", {
    method: "POST",
  });
}

export async function getMySpotifyLibrarySyncStatus() {
  return requestJson<{
    ok: true;
    userId: string;
    status: "idle" | "syncing" | "completed" | "error";
    progress: number;
    totalTracks: number;
    lastError: string | null;
    startedAtMs: number | null;
    completedAtMs: number | null;
    updatedAtMs: number;
  }>("/music/library/sync/status");
}

export async function getMyLikedTracks(input: { provider: "spotify" | "deezer"; limit?: number }) {
  const params = new URLSearchParams();
  if (typeof input.limit === "number") params.set("limit", String(input.limit));
  const query = params.toString();
  return requestJson<{
    ok: true;
    provider: "spotify" | "deezer";
    total: number | null;
    tracks: Array<{
      provider: "spotify" | "deezer" | "youtube";
      id: string;
      title: string;
      artist: string;
      previewUrl: string | null;
      sourceUrl: string | null;
    }>;
  }>(`/account/music/${input.provider}/liked${query.length > 0 ? `?${query}` : ""}`);
}

export async function getMyPlaylists(input: { provider: "spotify" | "deezer"; limit?: number }) {
  const params = new URLSearchParams();
  if (typeof input.limit === "number") params.set("limit", String(input.limit));
  const query = params.toString();
  return requestJson<{
    ok: true;
    provider: "spotify" | "deezer";
    playlists: Array<{
      provider: "spotify" | "deezer";
      id: string;
      name: string;
      description: string;
      imageUrl: string | null;
      externalUrl: string;
      owner: string | null;
      trackCount: number | null;
      sourceQuery: string;
    }>;
  }>(`/account/music/${input.provider}/playlists${query.length > 0 ? `?${query}` : ""}`);
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
