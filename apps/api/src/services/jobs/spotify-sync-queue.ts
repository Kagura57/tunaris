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

  return await queue.add(
    SPOTIFY_SYNC_JOB_NAME,
    { userId: normalizedUserId },
    {
      jobId: `spotify-sync:${normalizedUserId}`,
    },
  );
}
