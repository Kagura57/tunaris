import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSpotifyClientToken,
  resetSpotifyClientTokenCacheForTests,
} from "../src/routes/music/spotify";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("spotify server auth", () => {
  const envKeys = ["SPOTIFY_ACCESS_TOKEN", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"] as const;
  const originalEnv = new Map<string, string | undefined>();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetSpotifyClientTokenCacheForTests();
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

  it("returns a client credentials token when credentials are configured", async () => {
    process.env.SPOTIFY_CLIENT_ID = "client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "client-secret";
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: "fresh-client-token",
        expires_in: 3600,
      }),
    ) as unknown as typeof fetch;

    const token = await getSpotifyClientToken();
    expect(token).toBe("fresh-client-token");
  });

  it("caches client credentials token and avoids duplicate oauth calls", async () => {
    process.env.SPOTIFY_CLIENT_ID = "client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "client-secret";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: "cached-client-token",
        expires_in: 3600,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await getSpotifyClientToken();
    const second = await getSpotifyClientToken();

    expect(first).toBe("cached-client-token");
    expect(second).toBe("cached-client-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to static token when client credentials exchange fails", async () => {
    process.env.SPOTIFY_ACCESS_TOKEN = "fallback-static-token";
    process.env.SPOTIFY_CLIENT_ID = "client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "client-secret";
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "invalid_client" }, 401)) as unknown as typeof fetch;

    const token = await getSpotifyClientToken();
    expect(token).toBe("fallback-static-token");
  });
});
