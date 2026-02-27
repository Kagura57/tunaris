import { afterEach, describe, expect, it, vi } from "vitest";
import * as httpModule from "../src/routes/music/http";
import * as accountRepoModule from "../src/repositories/MusicAccountRepository";
import * as syncRepoModule from "../src/repositories/UserLibrarySyncRepository";
import * as queueModule from "../src/services/jobs/spotify-sync-queue";
import * as syncTriggerModule from "../src/services/jobs/spotify-sync-trigger";
import { buildMusicConnectUrl, handleMusicOAuthCallback } from "../src/services/MusicOAuthService";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("music oauth spotify sync trigger", () => {
  it("resets sync state and queues spotify sync when oauth callback succeeds", async () => {
    process.env.SPOTIFY_CLIENT_ID = "spotify-client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "spotify-client-secret";
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";

    const connect = buildMusicConnectUrl({
      provider: "spotify",
      userId: "oauth-user-1",
      returnTo: "/profile",
    });
    expect(connect).not.toBeNull();
    if (!connect) return;

    vi.spyOn(httpModule, "fetchJsonWithTimeout")
      .mockResolvedValueOnce({
        access_token: "spotify-access",
        refresh_token: "spotify-refresh",
        expires_in: 3600,
        scope: "user-library-read",
      })
      .mockResolvedValueOnce({
        id: "spotify-provider-user-1",
      });
    vi.spyOn(accountRepoModule.musicAccountRepository, "upsertLink").mockResolvedValue({} as never);
    const syncStateSpy = vi.spyOn(syncRepoModule.userLibrarySyncRepository, "upsert").mockResolvedValue({
      userId: "oauth-user-1",
      status: "idle",
      progress: 0,
      totalTracks: 0,
      lastError: null,
      startedAtMs: null,
      completedAtMs: null,
      updatedAtMs: Date.now(),
    });
    vi.spyOn(queueModule, "isSpotifySyncQueueConfigured").mockReturnValue(true);
    const queueSpy = vi.spyOn(syncTriggerModule, "queueSpotifySyncForUser").mockResolvedValue({
      queued: true,
      mode: "bullmq",
      jobId: "job-1",
    });

    const result = await handleMusicOAuthCallback({
      provider: "spotify",
      code: "oauth-code",
      state: connect.state,
    });

    expect(result.ok).toBe(true);
    expect(syncStateSpy).toHaveBeenCalledWith({
      userId: "oauth-user-1",
      status: "idle",
      progress: 0,
      totalTracks: 0,
      lastError: null,
      startedAtMs: null,
      completedAtMs: null,
    });
    expect(queueSpy).toHaveBeenCalledWith("oauth-user-1");
  });
});
