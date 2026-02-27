import { randomUUID } from "node:crypto";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { readEnvVar } from "./lib/env";
import { logEvent } from "./lib/logger";
import { providerMetricsSnapshot } from "./lib/provider-metrics";
import { authRoutes } from "./routes/auth";
import { accountRoutes } from "./routes/account";
import { animeAutocompleteRoutes } from "./routes/anime/autocomplete";
import { quizRoutes } from "./routes/quiz";
import { realtimeRoutes } from "./routes/realtime";
import { roomRoutes } from "./routes/room";
import { startAnimeThemesCatalogRefreshJob } from "./services/jobs/animethemes-catalog-refresh";
import { startAniListSyncWorker } from "./services/jobs/anilist-sync-worker";
import { roomStore } from "./services/RoomStore";
import { trackCache } from "./services/TrackCache";

const DEFAULT_API_PORT = 3001;

function readApiPort() {
  const raw = process.env.PORT;
  if (!raw) return DEFAULT_API_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_API_PORT;
  return parsed;
}

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
    service: "kwizik-api",
    now: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    rooms: roomStore.diagnostics(),
    trackCache: trackCache.stats(),
    providers: providerMetricsSnapshot(),
    integrations: {
      hasAniListAccessToken:
        typeof readEnvVar("ANILIST_ACCESS_TOKEN") === "string" &&
        (readEnvVar("ANILIST_ACCESS_TOKEN")?.length ?? 0) > 0,
      configuredSourceExamples: [
        "anilist:linked:union",
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
  .use(animeAutocompleteRoutes)
  .use(quizRoutes)
  .use(realtimeRoutes)
  .use(roomRoutes)
  .group("/api", (scoped) =>
    scoped
      .get("/health", () => ({ ok: true as const }))
      .get("/health/details", () => buildHealthDetailsPayload()),
  );

if (import.meta.main) {
  const apiPort = readApiPort();
  app.listen({
    hostname: "0.0.0.0",
    port: apiPort,
  });
  startAnimeThemesCatalogRefreshJob();
  startAniListSyncWorker();
  console.log(`Kwizik API running on http://0.0.0.0:${apiPort}`);
}
