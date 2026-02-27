import { aniListSyncRunRepository } from "../../repositories/AniListSyncRunRepository";
import { enqueueAniListSyncJob, isAniListSyncQueueConfigured } from "./anilist-sync-queue";

function normalize(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function queueAniListSyncForUser(userIdInput: unknown) {
  const userId = normalize(userIdInput);
  if (!userId) {
    return { queued: false as const, reason: "INVALID_USER_ID" as const, runId: null };
  }

  const run = await aniListSyncRunRepository.createQueued(userId);

  if (!isAniListSyncQueueConfigured()) {
    await aniListSyncRunRepository.update({
      runId: run.id,
      status: "error",
      progress: 0,
      message: "QUEUE_UNAVAILABLE",
      finishedAtMs: Date.now(),
    });
    return { queued: false as const, reason: "QUEUE_UNAVAILABLE" as const, runId: run.id };
  }

  const job = await enqueueAniListSyncJob({
    userId,
    runId: run.id,
  });

  if (!job) {
    await aniListSyncRunRepository.update({
      runId: run.id,
      status: "error",
      progress: 0,
      message: "ENQUEUE_FAILED",
      finishedAtMs: Date.now(),
    });
    return { queued: false as const, reason: "ENQUEUE_FAILED" as const, runId: run.id };
  }

  return {
    queued: true as const,
    mode: "bullmq" as const,
    runId: run.id,
    jobId: job.id ?? null,
  };
}
