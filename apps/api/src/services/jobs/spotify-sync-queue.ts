import IORedis from "ioredis";
import { Queue } from "bullmq";
import { readRedisUrl } from "../../lib/env";

export const SPOTIFY_SYNC_QUEUE_NAME = "spotify-sync-queue";
export const SPOTIFY_SYNC_JOB_NAME = "sync-user-library";

export type SpotifySyncJobPayload = {
  userId: string;
};

let redisConnection: IORedis | null = null;
let spotifySyncQueue: Queue<SpotifySyncJobPayload> | null = null;

export function buildSpotifySyncJobId(userId: string) {
  const normalized = userId.trim();
  if (!normalized) return "spotify-sync-unknown";
  const safe = normalized.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `spotify-sync-${safe}`;
}

function getRedisConnection() {
  const redisUrl = readRedisUrl();
  if (!redisUrl) return null;
  if (!redisConnection) {
    redisConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  }
  return redisConnection;
}

export function isSpotifySyncQueueConfigured() {
  return Boolean(readRedisUrl());
}

export function getSpotifySyncQueue() {
  if (spotifySyncQueue) return spotifySyncQueue;
  const connection = getRedisConnection();
  if (!connection) return null;
  spotifySyncQueue = new Queue<SpotifySyncJobPayload>(SPOTIFY_SYNC_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 8,
      backoff: {
        type: "exponential",
        delay: 5_000,
      },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
  return spotifySyncQueue;
}

export async function enqueueSpotifyLibrarySyncJob(userId: string) {
  const queue = getSpotifySyncQueue();
  if (!queue) return null;
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) return null;
  const jobId = buildSpotifySyncJobId(normalizedUserId);

  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "waiting" || state === "active" || state === "delayed" || state === "paused") {
      return existing;
    }
    if (state === "completed" || state === "failed") {
      await existing.remove();
    }
  }

  return await queue.add(
    SPOTIFY_SYNC_JOB_NAME,
    { userId: normalizedUserId },
    {
      jobId,
    },
  );
}
