import { Worker } from "bullmq";
import IORedis from "ioredis";
import { readRedisUrl } from "../../lib/env";
import { logEvent } from "../../lib/logger";
import { userLibrarySyncRepository } from "../../repositories/UserLibrarySyncRepository";
import {
  SpotifySyncRateLimitError,
  syncUserLikedTracksLibrary,
  type LibrarySyncProgressUpdate,
} from "../UserMusicLibrary";
import { SPOTIFY_SYNC_JOB_NAME, SPOTIFY_SYNC_QUEUE_NAME, type SpotifySyncJobPayload } from "./spotify-sync-queue";

let workerInstance: Worker<SpotifySyncJobPayload> | null = null;
let workerConnection: IORedis | null = null;

function progressFromUpdate(update: LibrarySyncProgressUpdate) {
  if (!Number.isFinite(update.progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(update.progress)));
}

export function startSpotifySyncWorker() {
  if (workerInstance) return workerInstance;
  const redisUrl = readRedisUrl();
  if (!redisUrl) {
    logEvent("warn", "spotify_sync_worker_disabled_missing_redis_url");
    return null;
  }

  workerConnection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  workerInstance = new Worker<SpotifySyncJobPayload>(
    SPOTIFY_SYNC_QUEUE_NAME,
    async (job) => {
      const userId = job.data.userId?.trim() ?? "";
      if (!userId) {
        throw new Error("INVALID_USER_ID");
      }
      const startedAtMs = Date.now();

      await userLibrarySyncRepository.upsert({
        userId,
        status: "syncing",
        progress: 0,
        totalTracks: 0,
        lastError: null,
        startedAtMs,
        completedAtMs: null,
      });

      const pushProgress = async (update: LibrarySyncProgressUpdate) => {
        const progress = progressFromUpdate(update);
        const totalTracks =
          typeof update.totalTracks === "number" && Number.isFinite(update.totalTracks)
            ? Math.max(0, Math.round(update.totalTracks))
            : 0;
        await job.updateProgress(progress);
        await userLibrarySyncRepository.upsert({
          userId,
          status: update.stage === "completed" ? "completed" : "syncing",
          progress,
          totalTracks,
          lastError: null,
          startedAtMs,
          completedAtMs: update.stage === "completed" ? Date.now() : null,
        });
      };

      try {
        const result = await syncUserLikedTracksLibrary({
          userId,
          provider: "spotify",
          onProgress: pushProgress,
        });

        await pushProgress({
          stage: "completed",
          progress: 100,
          processedTracks: result.savedCount,
          totalTracks:
            typeof result.providerTotal === "number" && Number.isFinite(result.providerTotal)
              ? result.providerTotal
              : result.savedCount,
        });

        logEvent("info", "spotify_library_sync_job_completed", {
          userId,
          fetchedCount: result.fetchedCount,
          savedCount: result.savedCount,
          uniqueCount: result.uniqueCount,
          jobId: job.id ?? null,
          attemptsMade: job.attemptsMade,
        });

        return result;
      } catch (error) {
        if (error instanceof SpotifySyncRateLimitError) {
          const retryAfterMs = Math.max(1_000, error.retryAfterMs);
          await userLibrarySyncRepository.upsert({
            userId,
            status: "syncing",
            progress: 0,
            totalTracks: 0,
            lastError: `RATE_LIMITED_RETRY_AFTER_${retryAfterMs}MS`,
            startedAtMs,
            completedAtMs: null,
          });
          throw new Error(`SPOTIFY_RATE_LIMITED_RETRY_AFTER_${retryAfterMs}MS`);
        }

        const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
        await userLibrarySyncRepository.upsert({
          userId,
          status: "error",
          progress: 0,
          totalTracks: 0,
          lastError: message,
          startedAtMs,
          completedAtMs: null,
        });
        throw error;
      }
    },
    {
      connection: workerConnection,
      concurrency: 1,
      limiter: {
        max: 1,
        duration: 1_000,
      },
    },
  );

  workerInstance.on("active", (job) => {
    logEvent("info", "spotify_library_sync_job_active", {
      userId: job.data.userId,
      jobId: job.id ?? null,
      attemptsMade: job.attemptsMade,
    });
  });

  workerInstance.on("failed", async (job, error) => {
    const userId = job?.data?.userId ?? null;
    logEvent("warn", "spotify_library_sync_job_failed", {
      userId,
      jobId: job?.id ?? null,
      attemptsMade: job?.attemptsMade ?? 0,
      error: error?.message ?? "UNKNOWN_ERROR",
    });
    if (userId && (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1)) {
      await userLibrarySyncRepository.upsert({
        userId,
        status: "error",
        progress: 0,
        totalTracks: 0,
        lastError: error?.message ?? "UNKNOWN_ERROR",
        startedAtMs: null,
        completedAtMs: null,
      });
    }
  });

  workerInstance.on("completed", (job) => {
    logEvent("info", "spotify_library_sync_job_done", {
      userId: job.data.userId,
      jobId: job.id ?? null,
      attemptsMade: job.attemptsMade,
      name: SPOTIFY_SYNC_JOB_NAME,
    });
  });

  return workerInstance;
}
