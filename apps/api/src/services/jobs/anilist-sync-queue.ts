import IORedis from "ioredis";
import { Queue } from "bullmq";
import { readRedisUrl } from "../../lib/env";

export const ANILIST_SYNC_QUEUE_NAME = "anilist-sync-queue";
export const ANILIST_SYNC_JOB_NAME = "sync-user-anilist";

export type AniListSyncJobPayload = {
  userId: string;
  runId: number;
};

let redisConnection: IORedis | null = null;
let anilistSyncQueue: Queue<AniListSyncJobPayload> | null = null;

export function buildAniListSyncJobId(userId: string) {
  const normalized = userId.trim();
  if (!normalized) return "anilist-sync-unknown";
  const safe = normalized.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `anilist-sync-${safe}`;
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

export function isAniListSyncQueueConfigured() {
  return Boolean(readRedisUrl());
}

export function getAniListSyncQueue() {
  if (anilistSyncQueue) return anilistSyncQueue;
  const connection = getRedisConnection();
  if (!connection) return null;
  anilistSyncQueue = new Queue<AniListSyncJobPayload>(ANILIST_SYNC_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 6,
      backoff: {
        type: "exponential",
        delay: 3_000,
      },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
  return anilistSyncQueue;
}

export async function enqueueAniListSyncJob(input: { userId: string; runId: number }) {
  const queue = getAniListSyncQueue();
  if (!queue) return null;
  const userId = input.userId.trim();
  const runId = Math.max(1, Math.floor(input.runId));
  if (!userId) return null;

  const jobId = `${buildAniListSyncJobId(userId)}-${runId}`;
  return await queue.add(
    ANILIST_SYNC_JOB_NAME,
    {
      userId,
      runId,
    },
    {
      jobId,
    },
  );
}
