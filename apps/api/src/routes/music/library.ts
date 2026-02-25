import { Elysia } from "elysia";
import { readSessionFromHeaders } from "../../auth/client";
import { queueSpotifySyncForUser } from "../../services/jobs/spotify-sync-trigger";
import { userLibrarySyncRepository } from "../../repositories/UserLibrarySyncRepository";

async function queueLibrarySync({ headers, set }: { headers: unknown; set: { status: number } }) {
    const authContext = await readSessionFromHeaders(headers as unknown as Headers);
    if (!authContext?.user?.id) {
      set.status = 401;
      return { ok: false as const, error: "UNAUTHORIZED" };
    }

    const userId = authContext.user.id;
    const enqueueResult = await queueSpotifySyncForUser(userId);
    if (!enqueueResult.queued) {
      set.status = 503;
      return {
        ok: false as const,
        error: enqueueResult.reason,
        code: "SYNC_QUEUE_UNAVAILABLE" as const,
        reason: enqueueResult.reason,
      };
    }

    set.status = 202;
    return {
      ok: true as const,
      message: "Sync job queued" as const,
      status: "accepted" as const,
      mode: enqueueResult.mode,
      jobId: enqueueResult.jobId,
    };
}

async function getLibrarySyncStatus({ headers, set }: { headers: unknown; set: { status: number } }) {
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
}

function buildLibraryRoutes(prefix: string) {
  return new Elysia({ prefix })
    .post("/sync", queueLibrarySync)
    .get("/sync/status", getLibrarySyncStatus);
}

export const musicLibraryRoutes = new Elysia()
  .use(buildLibraryRoutes("/music/library"))
  .use(buildLibraryRoutes("/api/music/library"));
