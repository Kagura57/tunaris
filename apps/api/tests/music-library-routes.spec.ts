import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import * as authClientModule from "../src/auth/client";
import * as queueModule from "../src/services/jobs/spotify-sync-queue";
import * as syncRepoModule from "../src/repositories/UserLibrarySyncRepository";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("music library sync routes", () => {
  it("returns unauthorized when no session is present", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/music/library/sync", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("UNAUTHORIZED");
  });

  it("accepts sync job for authenticated users", async () => {
    vi.spyOn(authClientModule, "readSessionFromHeaders").mockResolvedValue({
      session: {
        id: "session-1",
        userId: "user-1",
        expiresAt: new Date(Date.now() + 60_000),
      },
      user: {
        id: "user-1",
        name: "User One",
        email: "user@example.com",
      },
    });
    vi.spyOn(queueModule, "isSpotifySyncQueueConfigured").mockReturnValue(true);
    const enqueueSpy = vi.spyOn(queueModule, "enqueueSpotifyLibrarySyncJob").mockResolvedValue({
      id: "job-1",
    } as Awaited<ReturnType<typeof queueModule.enqueueSpotifyLibrarySyncJob>>);
    const upsertSpy = vi.spyOn(syncRepoModule.userLibrarySyncRepository, "upsert").mockResolvedValue({
      userId: "user-1",
      status: "syncing",
      progress: 0,
      totalTracks: 0,
      lastError: null,
      startedAtMs: Date.now(),
      completedAtMs: null,
      updatedAtMs: Date.now(),
    });

    const response = await app.handle(
      new Request("http://localhost/api/music/library/sync", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    const payload = (await response.json()) as {
      ok: boolean;
      status: string;
      jobId: string | null;
    };
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe("accepted");
    expect(payload.jobId).toBe("job-1");
    expect(upsertSpy).toHaveBeenCalled();
    expect(enqueueSpy).toHaveBeenCalledWith("user-1");
  });

  it("returns current sync status for authenticated users", async () => {
    vi.spyOn(authClientModule, "readSessionFromHeaders").mockResolvedValue({
      session: {
        id: "session-1",
        userId: "user-1",
        expiresAt: new Date(Date.now() + 60_000),
      },
      user: {
        id: "user-1",
        name: "User One",
        email: "user@example.com",
      },
    });
    vi.spyOn(syncRepoModule.userLibrarySyncRepository, "get").mockResolvedValue({
      userId: "user-1",
      status: "syncing",
      progress: 42,
      totalTracks: 1200,
      lastError: null,
      startedAtMs: Date.now() - 5_000,
      completedAtMs: null,
      updatedAtMs: Date.now(),
    });

    const response = await app.handle(
      new Request("http://localhost/api/music/library/sync/status"),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      status: string;
      progress: number;
      totalTracks: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe("syncing");
    expect(payload.progress).toBe(42);
    expect(payload.totalTracks).toBe(1200);
  });
});
