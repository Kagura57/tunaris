import { Elysia } from "elysia";
import { readSessionFromHeaders } from "../../auth/client";
import { enqueueSpotifyLibrarySyncJob, isSpotifySyncQueueConfigured } from "../../services/jobs/spotify-sync-queue";
import { userLibrarySyncRepository } from "../../repositories/UserLibrarySyncRepository";

export const musicLibraryRoutes = new Elysia({ prefix: "/api/music/library" })
  .post("/sync", async ({ headers, set }) => {
    const authContext = await readSessionFromHeaders(headers as unknown as Headers);
    if (!authContext?.user?.id) {
      set.status = 401;
      return { ok: false as const, error: "UNAUTHORIZED" };
    }

    if (!isSpotifySyncQueueConfigured()) {
      set.status = 503;
      return {
        ok: false as const,
        error: "SYNC_QUEUE_UNAVAILABLE",
      };
    }

    const userId = authContext.user.id;
    await userLibrarySyncRepository.upsert({
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
      set.status = 503;
      await userLibrarySyncRepository.upsert({
        userId,
        status: "error",
        progress: 0,
        totalTracks: 0,
        lastError: "SYNC_QUEUE_UNAVAILABLE",
        startedAtMs: Date.now(),
        completedAtMs: null,
      });
      return {
        ok: false as const,
        error: "SYNC_QUEUE_UNAVAILABLE",
      };
    }

    set.status = 202;
    return {
      ok: true as const,
      status: "accepted" as const,
      jobId: job.id ?? null,
    };
  })
  .get("/sync/status", async ({ headers, set }) => {
    const authContext = await readSessionFromHeaders(headers as unknown as Headers);
    if (!authContext?.user?.id) {
      set.status = 401;
      return { ok: false as const, error: "UNAUTHORIZED" };
    }

    const state = await userLibrarySyncRepository.get(authContext.user.id);
    return {
      ok: true as const,
      userId: authContext.user.id,
      status: state.status,
      progress: state.progress,
      totalTracks: state.totalTracks,
      lastError: state.lastError,
      startedAtMs: state.startedAtMs,
      completedAtMs: state.completedAtMs,
      updatedAtMs: state.updatedAtMs,
    };
  });
