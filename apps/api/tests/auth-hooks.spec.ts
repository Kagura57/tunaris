import { afterEach, describe, expect, it, vi } from "vitest";
import { queueSpotifySyncForAccountLink } from "../src/services/jobs/spotify-sync-trigger";
import * as queueModule from "../src/services/jobs/spotify-sync-queue";
import * as syncRepoModule from "../src/repositories/UserLibrarySyncRepository";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("better-auth spotify account hook", () => {
  it("queues a sync job when a spotify account is linked", async () => {
    vi.spyOn(queueModule, "isSpotifySyncQueueConfigured").mockReturnValue(true);
    const enqueueSpy = vi.spyOn(queueModule, "enqueueSpotifyLibrarySyncJob").mockResolvedValue({
      id: "job-spotify-1",
    } as Awaited<ReturnType<typeof queueModule.enqueueSpotifyLibrarySyncJob>>);
    const upsertSpy = vi.spyOn(syncRepoModule.userLibrarySyncRepository, "upsert").mockResolvedValue({
      userId: "user-123",
      status: "syncing",
      progress: 0,
      totalTracks: 0,
      lastError: null,
      startedAtMs: Date.now(),
      completedAtMs: null,
      updatedAtMs: Date.now(),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await queueSpotifySyncForAccountLink({
      providerId: "spotify",
      userId: "user-123",
    });

    expect(result.queued).toBe(true);
    expect(upsertSpy).toHaveBeenCalled();
    expect(enqueueSpy).toHaveBeenCalledWith("user-123");
    expect(logSpy).toHaveBeenCalledWith("[BullMQ] Spotify sync job queued for user:", "user-123");
  });

  it("ignores non-spotify providers", async () => {
    vi.spyOn(queueModule, "isSpotifySyncQueueConfigured").mockReturnValue(true);
    const enqueueSpy = vi.spyOn(queueModule, "enqueueSpotifyLibrarySyncJob");

    const result = await queueSpotifySyncForAccountLink({
      providerId: "credential",
      userId: "user-123",
    });

    expect(result.queued).toBe(false);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
