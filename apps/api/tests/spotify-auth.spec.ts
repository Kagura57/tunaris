import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSpotifyAccessToken,
  resetSpotifyTokenCacheForTests,
} from "../src/routes/music/spotify-auth";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("spotify auth", () => {
  const envKeys = ["SPOTIFY_ACCESS_TOKEN", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"] as const;
  const originalEnv = new Map<string, string | undefined>();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetSpotifyTokenCacheForTests();
    for (const key of envKeys) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = " ";
    }
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    for (const key of envKeys) {
      const original = originalEnv.get(key);
      if (typeof original === "string") {
        process.env[key] = original;
      } else {
        delete process.env[key];
      }
    }
    originalEnv.clear();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("prefers client credentials token when credentials are configured", async () => {
    process.env.SPOTIFY_ACCESS_TOKEN = "stale-static-token";
    process.env.SPOTIFY_CLIENT_ID = "client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "client-secret";
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: "fresh-client-token",
        expires_in: 3600,
      }),
    ) as unknown as typeof fetch;

    const token = await getSpotifyAccessToken();
    expect(token).toBe("fresh-client-token");
  });

  it("falls back to static token when client credentials exchange fails", async () => {
    process.env.SPOTIFY_ACCESS_TOKEN = "fallback-static-token";
    process.env.SPOTIFY_CLIENT_ID = "client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "client-secret";
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "invalid_client" }, 401)) as unknown as typeof fetch;

    const token = await getSpotifyAccessToken();
    expect(token).toBe("fallback-static-token");
  });

  it("normalizes static token with bearer prefix", async () => {
    process.env.SPOTIFY_ACCESS_TOKEN = "Bearer abc123";
    process.env.SPOTIFY_CLIENT_ID = " ";
    process.env.SPOTIFY_CLIENT_SECRET = " ";

    const token = await getSpotifyAccessToken();
    expect(token).toBe("abc123");
  });
});
