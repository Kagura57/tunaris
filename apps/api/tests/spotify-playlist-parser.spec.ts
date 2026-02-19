import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSpotifyPlaylistTracks } from "../src/routes/music/spotify";
import { resetSpotifyTokenCacheForTests } from "../src/routes/music/spotify-auth";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("spotify playlist payload parsing", () => {
  const envKeys = ["SPOTIFY_ACCESS_TOKEN", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"] as const;
  const originalEnv = new Map<string, string | undefined>();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetSpotifyTokenCacheForTests();
    for (const key of envKeys) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = " ";
    }
    process.env.SPOTIFY_ACCESS_TOKEN = "static-token";
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

  it("parses playlist entries from modern item field", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            items: [
              {
                item: {
                  id: "track-modern",
                  name: "Song Modern",
                  artists: [{ name: "Artist One" }],
                  preview_url: "https://cdn.example.com/preview.mp3",
                  external_urls: { spotify: "https://open.spotify.com/track/track-modern" },
                },
              },
            ],
          }),
        ),
      ) as unknown as typeof fetch;

    const tracks = await fetchSpotifyPlaylistTracks("playlist-id", 5);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      id: "track-modern",
      title: "Song Modern",
      artist: "Artist One",
    });
  });

  it("keeps compatibility with legacy track field", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            items: [
              {
                track: {
                  id: "track-legacy",
                  name: "Song Legacy",
                  artists: [{ name: "Artist Two" }],
                  preview_url: "https://cdn.example.com/legacy.mp3",
                  external_urls: { spotify: "https://open.spotify.com/track/track-legacy" },
                },
              },
            ],
          }),
        ),
      ) as unknown as typeof fetch;

    const tracks = await fetchSpotifyPlaylistTracks("playlist-id", 5);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      id: "track-legacy",
      title: "Song Legacy",
      artist: "Artist Two",
    });
  });
});
