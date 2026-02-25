import { userLibrarySyncRepository } from "../../repositories/UserLibrarySyncRepository";
import { enqueueSpotifyLibrarySyncJob, isSpotifySyncQueueConfigured } from "./spotify-sync-queue";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function compactErrorReason(value: string) {
  const compact = value.trim().replace(/\s+/g, " ");
  if (compact.length <= 160) return compact;
  return compact.slice(0, 160);
}

async function persistSyncState(input: {
  userId: string;
  status: "syncing" | "completed" | "error";
  progress: number;
  totalTracks: number;
  lastError: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
}) {
  try {
    await userLibrarySyncRepository.upsert({
      userId: input.userId,
      status: input.status,
      progress: input.progress,
      totalTracks: input.totalTracks,
      lastError: input.lastError,
      startedAtMs: input.startedAtMs,
      completedAtMs: input.completedAtMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    console.warn("[BullMQ] Failed to persist sync status:", {
      userId: input.userId,
      status: input.status,
      error: message,
    });
  }
}

export async function queueSpotifySyncForUser(userIdInput: unknown) {
  const userId = normalizeString(userIdInput);
  if (!userId) {
    return { queued: false as const, reason: "INVALID_USER_ID" as const };
  }

  if (!isSpotifySyncQueueConfigured()) {
    await persistSyncState({
      userId,
      status: "error",
      progress: 0,
      totalTracks: 0,
      lastError: "QUEUE_UNAVAILABLE",
      startedAtMs: null,
      completedAtMs: null,
    });
    console.warn("[BullMQ] Spotify sync queue unavailable for user:", userId);
    return { queued: false as const, reason: "QUEUE_UNAVAILABLE" as const };
  }

  try {
    await persistSyncState({
      userId,
      status: "syncing",
      progress: 0,
      totalTracks: 0,
      lastError: null,
      startedAtMs: Date.now(),
      completedAtMs: null,
    });
    const job = await enqueueSpotifyLibrarySyncJob(userId);
    if (!job) {
      await persistSyncState({
        userId,
        status: "error",
        progress: 0,
        totalTracks: 0,
        lastError: "ENQUEUE_FAILED",
        startedAtMs: Date.now(),
        completedAtMs: null,
      });
      return { queued: false as const, reason: "ENQUEUE_FAILED" as const };
    }
    console.log("[BullMQ] Spotify sync job queued for user:", userId);
    return { queued: true as const, mode: "bullmq" as const, jobId: job.id ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    await persistSyncState({
      userId,
      status: "error",
      progress: 0,
      totalTracks: 0,
      lastError: `ENQUEUE_EXCEPTION:${message}`,
      startedAtMs: Date.now(),
      completedAtMs: null,
    });
    console.warn("[BullMQ] Exception while queueing Spotify sync job:", { userId, error: message });
    return {
      queued: false as const,
      reason: `ENQUEUE_EXCEPTION:${compactErrorReason(message)}`,
    };
  }
}

export async function queueSpotifySyncForAccountLink(account: {
  providerId?: unknown;
  userId?: unknown;
}) {
  const providerId = normalizeString(account.providerId).toLowerCase();
  if (providerId !== "spotify") {
    return { queued: false as const, reason: "IGNORED_NON_SPOTIFY" as const };
  }
  return queueSpotifySyncForUser(account.userId);
}
