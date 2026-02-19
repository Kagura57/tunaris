import { describe, expect, it } from "vitest";
import { unifiedMusicSearch } from "../src/services/MusicAggregator";
import type { MusicTrack } from "../src/services/music-types";

function track(
  provider: MusicTrack["provider"],
  id: string,
  title: string,
  artist: string,
  previewUrl: string | null = null,
): MusicTrack {
  return {
    provider,
    id,
    title,
    artist,
    previewUrl,
    sourceUrl: null,
  };
}

describe("MusicAggregator", () => {
  it("builds fallback list using provider order and deduplicates title/artist", async () => {
    const result = await unifiedMusicSearch("test", 5, {
      targetFallbackCount: 3,
      searchers: {
        spotify: async () => [
          track("spotify", "1", "Song A", "Artist A"),
          track("spotify", "2", "Song B", "Artist B"),
        ],
        deezer: async () => [
          track("deezer", "9", "Song A", "Artist A"),
          track("deezer", "3", "Song C", "Artist C"),
        ],
        "apple-music": async () => [],
        tidal: async () => [],
        ytmusic: async () => [],
        youtube: async () => [],
      },
    });

    expect(result.fallback).toHaveLength(3);
    expect(result.fallback[0]?.provider).toBe("spotify");
    expect(result.fallback[1]?.title).toBe("Song B");
    expect(result.fallback[2]?.title).toBe("Song C");
  });

  it("captures provider errors and continues other providers", async () => {
    const result = await unifiedMusicSearch("test", 5, {
      searchers: {
        spotify: async () => {
          throw new Error("SPOTIFY_DOWN");
        },
        deezer: async () => [track("deezer", "1", "Song X", "Artist X")],
        "apple-music": async () => [],
        tidal: async () => [],
        ytmusic: async () => [],
        youtube: async () => [],
      },
    });

    expect(result.results.spotify).toEqual([]);
    expect(result.providerErrors.spotify).toBe("SPOTIFY_DOWN");
    expect(result.results.deezer).toHaveLength(1);
    expect(result.fallback[0]?.provider).toBe("deezer");
  });

  it("prioritizes tracks with preview urls in fallback", async () => {
    const result = await unifiedMusicSearch("test", 5, {
      targetFallbackCount: 2,
      searchers: {
        spotify: async () => [track("spotify", "1", "Song Silent", "Artist A", null)],
        deezer: async () => [track("deezer", "2", "Song Loud", "Artist B", "https://preview.test/2.mp3")],
        "apple-music": async () => [],
        tidal: async () => [],
        ytmusic: async () => [],
        youtube: async () => [],
      },
    });

    expect(result.fallback[0]?.title).toBe("Song Loud");
    expect(result.fallback[0]?.previewUrl).toBe("https://preview.test/2.mp3");
  });
});
