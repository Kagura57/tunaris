import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUserLikedTracks, syncUserLikedTracksLibrary } from "../src/services/UserMusicLibrary";
import { musicAccountRepository } from "../src/repositories/MusicAccountRepository";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("spotify liked tracks fetching", () => {
  const userId = "spotify-liked-user";
  const originalFetch = globalThis.fetch;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSpotifyClientId = process.env.SPOTIFY_CLIENT_ID;
  const originalSpotifyClientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    await musicAccountRepository.deleteLink(userId, "spotify");
    await musicAccountRepository.upsertLink({
      userId,
      provider: "spotify",
      accessToken: "valid-access-token",
      refreshToken: "valid-refresh-token",
      scope: "user-library-read",
      expiresAtMs: Date.now() + 60 * 60_000,
    });
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    await musicAccountRepository.deleteLink(userId, "spotify");
    if (typeof originalDatabaseUrl === "string") {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    globalThis.fetch = originalFetch;
    if (typeof originalSpotifyClientId === "string") {
      process.env.SPOTIFY_CLIENT_ID = originalSpotifyClientId;
    } else {
      delete process.env.SPOTIFY_CLIENT_ID;
    }
    if (typeof originalSpotifyClientSecret === "string") {
      process.env.SPOTIFY_CLIENT_SECRET = originalSpotifyClientSecret;
    } else {
      delete process.env.SPOTIFY_CLIENT_SECRET;
    }
    vi.restoreAllMocks();
  });

  it("maps nested items[].track and keeps tracks when preview_url is null", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            added_at: "2026-02-24T00:00:00.000Z",
            track: {
              id: "track-1",
              name: "First Song",
              artists: [{ name: "First Artist" }],
              preview_url: null,
              external_urls: { spotify: "https://open.spotify.com/track/track-1" },
            },
          },
          {
            added_at: "2026-02-24T00:00:01.000Z",
            track: {
              id: "track-2",
              name: "Second Song",
              artists: [{ name: "Second Artist" }],
              preview_url: null,
              external_urls: { spotify: "https://open.spotify.com/track/track-2" },
            },
          },
        ],
        total: 2,
        next: null,
      }),
    ) as unknown as typeof fetch;

    const payload = await fetchUserLikedTracks(userId, "spotify", 20);
    expect(payload.total).toBe(2);
    expect(payload.tracks).toHaveLength(2);
    expect(payload.tracks[0]).toMatchObject({
      provider: "spotify",
      id: "track-1",
      title: "First Song",
      artist: "First Artist",
      previewUrl: null,
      sourceUrl: "https://open.spotify.com/track/track-1",
    });
    expect(payload.tracks[1]).toMatchObject({
      provider: "spotify",
      id: "track-2",
      title: "Second Song",
      artist: "Second Artist",
      previewUrl: null,
      sourceUrl: "https://open.spotify.com/track/track-2",
    });
  });

  it("logs spotify /me/tracks status with first item payload", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            track: {
              id: "track-log",
              name: "Log Song",
              artists: [{ name: "Log Artist" }],
              preview_url: null,
            },
          },
        ],
        total: 1,
        next: null,
      }),
    ) as unknown as typeof fetch;

    await fetchUserLikedTracks(userId, "spotify", 1);

    const debugEntry = logSpy.mock.calls.find(
      (call) => call[0] === "========== [spotify-liked-debug] /me/tracks raw_response ==========",
    );
    expect(debugEntry).toBeTruthy();
    expect(debugEntry?.[1]).toMatchObject({
      status: 200,
      itemCount: 1,
    });
    expect((debugEntry?.[1] as { firstItem?: string }).firstItem).toContain("\"track\"");
    expect((debugEntry?.[1] as { firstItem?: string }).firstItem).toContain("\"id\": \"track-log\"");
  });

  it("refreshes token and retries sync when spotify returns 401 once", async () => {
    process.env.SPOTIFY_CLIENT_ID = "test-client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "test-client-secret";

    const fetchMock = vi.fn().mockImplementation((input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("accounts.spotify.com/api/token")) {
        return Promise.resolve(
          jsonResponse({
            access_token: "refreshed-access-token",
            refresh_token: "refreshed-refresh-token",
            expires_in: 3600,
            scope: "user-library-read",
          }),
        );
      }

      if (url.includes("api.spotify.com/v1/me/tracks")) {
        const authHeader = (init?.headers as { authorization?: string } | undefined)?.authorization ?? "";
        if (authHeader === "Bearer valid-access-token") {
          return Promise.resolve(jsonResponse({ error: { status: 401, message: "token expired" } }, 401));
        }
        return Promise.resolve(
          jsonResponse({
            items: [
              {
                added_at: "2026-02-24T00:00:00.000Z",
                track: {
                  id: "track-sync-1",
                  name: "Synced Song",
                  artists: [{ name: "Synced Artist" }],
                  duration_ms: 120000,
                },
              },
            ],
            total: 1,
            next: null,
          }),
        );
      }

      return Promise.reject(new Error(`unexpected_url:${url}`));
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await syncUserLikedTracksLibrary({
      userId,
      provider: "spotify",
    });

    expect(result.savedCount).toBe(1);
    const meTrackCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("api.spotify.com/v1/me/tracks"),
    );
    expect(meTrackCalls.length).toBe(2);
    const secondHeaders = (meTrackCalls[1]?.[1] as RequestInit | undefined)?.headers as
      | { authorization?: string }
      | undefined;
    expect(secondHeaders?.authorization).toBe("Bearer refreshed-access-token");
  });

  it("returns explicit scope error when spotify responds 403 insufficient scope", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            status: 403,
            message: "Insufficient client scope",
          },
        },
        403,
      ),
    ) as unknown as typeof fetch;

    await expect(
      syncUserLikedTracksLibrary({
        userId,
        provider: "spotify",
      }),
    ).rejects.toThrowError("SPOTIFY_SYNC_SCOPE_MISSING_USER_LIBRARY_READ");
  });

  it("returns explicit account approval error when spotify rejects non-whitelisted users", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            status: 403,
            message: "User not registered in the Developer Dashboard",
          },
        },
        403,
      ),
    ) as unknown as typeof fetch;

    await expect(
      syncUserLikedTracksLibrary({
        userId,
        provider: "spotify",
      }),
    ).rejects.toThrowError("SPOTIFY_SYNC_ACCOUNT_NOT_APPROVED");
  });
});
