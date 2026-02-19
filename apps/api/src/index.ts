import { randomUUID } from "node:crypto";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { readEnvVar } from "./lib/env";
import { logEvent } from "./lib/logger";
import { providerMetricsSnapshot } from "./lib/provider-metrics";
import { authRoutes } from "./routes/auth";
import { accountRoutes } from "./routes/account";
import { musicSearchRoute } from "./routes/music/search";
import { musicSourceRoutes } from "./routes/music/source";
import { spotifyAuthDiagnostics } from "./routes/music/spotify-auth";
import { quizRoutes } from "./routes/quiz";
import { realtimeRoutes } from "./routes/realtime";
import { roomRoutes } from "./routes/room";
import { roomStore } from "./services/RoomStore";
import { trackCache } from "./services/TrackCache";

const API_PORT = 3001;

function resolveStatus(status: unknown) {
  if (typeof status === "number") return status;
  if (typeof status === "string") {
    const parsed = Number.parseInt(status, 10);
    return Number.isFinite(parsed) ? parsed : 200;
  }
  return 200;
}

function buildHealthDetailsPayload() {
  return {
    ok: true as const,
    service: "tunaris-api",
    now: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    rooms: roomStore.diagnostics(),
    trackCache: trackCache.stats(),
    providers: providerMetricsSnapshot(),
    integrations: {
      spotify: spotifyAuthDiagnostics(),
      deezerEnabled: readEnvVar("DEEZER_ENABLED") === "true",
      hasYouTubeApiKey:
        typeof readEnvVar("YOUTUBE_API_KEY") === "string" &&
        (readEnvVar("YOUTUBE_API_KEY")?.length ?? 0) > 0,
      hasYtMusicSearchUrl:
        typeof readEnvVar("YTMUSIC_SEARCH_URL") === "string" &&
        (readEnvVar("YTMUSIC_SEARCH_URL")?.length ?? 0) > 0,
      hasAniListAccessToken:
        typeof readEnvVar("ANILIST_ACCESS_TOKEN") === "string" &&
        (readEnvVar("ANILIST_ACCESS_TOKEN")?.length ?? 0) > 0,
      configuredSourceExamples: [
        "spotify:popular",
        "spotify:playlist:37i9dQZEVXbMDoHDwVN2tF",
        "deezer:chart",
        "deezer:playlist:3155776842",
        "anilist:users:userA,userB",
      ],
    },
  };
}

export const app = new Elysia()
  .derive(({ request, set }) => {
    const headerRequestId = request.headers.get("x-request-id")?.trim();
    const requestId = headerRequestId && headerRequestId.length > 0 ? headerRequestId : randomUUID();
    set.headers["x-request-id"] = requestId;

    return {
      requestId,
      requestStartMs: Date.now(),
    };
  })
  .onAfterResponse(({ request, set, requestId, requestStartMs }) => {
    const durationMs = Math.max(0, Date.now() - requestStartMs);
    logEvent("info", "http_request_complete", {
      requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      status: resolveStatus(set.status),
      durationMs,
    });
  })
  .get("/health", () => ({ ok: true as const }))
  .get("/health/details", () => buildHealthDetailsPayload())
  .use(
    cors({
      origin: true,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["content-type", "authorization", "cookie", "x-request-id"],
      exposedHeaders: ["x-request-id"],
    }),
  )
  .use(authRoutes)
  .use(accountRoutes)
  .use(musicSearchRoute)
  .use(musicSourceRoutes)
  .use(quizRoutes)
  .use(realtimeRoutes)
  .use(roomRoutes)
  .group("/api", (scoped) =>
    scoped
      .get("/health", () => ({ ok: true as const }))
      .get("/health/details", () => buildHealthDetailsPayload()),
  );

if (import.meta.main) {
  app.listen(API_PORT);
  console.log(`Tunaris API running on http://127.0.0.1:${API_PORT}`);
}
