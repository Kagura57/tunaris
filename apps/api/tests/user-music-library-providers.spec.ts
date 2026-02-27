import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as youtubeModule from "../src/routes/music/youtube";
import * as trackSourceResolverModule from "../src/services/TrackSourceResolver";
import { resolvedTrackRepository } from "../src/repositories/ResolvedTrackRepository";
import { userLikedTrackRepository } from "../src/repositories/UserLikedTrackRepository";

const originalDatabaseUrl = process.env.DATABASE_URL;

describe("fetchUserLikedTracksForProviders", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = " ";
    resolvedTrackRepository.clearMemory();
    userLikedTrackRepository.clearMemory();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resolvedTrackRepository.clearMemory();
    userLikedTrackRepository.clearMemory();
    vi.restoreAllMocks();

    if (typeof originalDatabaseUrl === "string") {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  it("returns playable tracks without throwing when logging includes userId", async () => {
    vi.spyOn(youtubeModule, "searchYouTube").mockResolvedValue([]);

    await userLikedTrackRepository.replaceForUserProvider({
      userId: "user-1",
      provider: "spotify",
      tracks: [
        {
          sourceId: "sp-1",
          addedAtMs: Date.now(),
          title: "Song",
          artist: "Artist",
          durationMs: 210_000,
        },
      ],
    });

    await resolvedTrackRepository.upsert({
      provider: "spotify",
      sourceId: "sp-1",
      title: "Song",
      artist: "Artist",
      youtubeVideoId: "yt-1",
      durationMs: 210_000,
    });

    const { fetchUserLikedTracksForProviders } = await import("../src/services/UserMusicLibrary");
    const output = await fetchUserLikedTracksForProviders({
      userId: " user-1 ",
      providers: ["spotify"],
      size: 10,
    });

    expect(output).toEqual([
      {
        provider: "youtube",
        id: "yt-1",
        title: "Song",
        artist: "Artist",
        durationSec: 210,
        previewUrl: null,
        sourceUrl: "https://www.youtube.com/watch?v=yt-1",
      },
    ]);
  });

  it("runs a second resolve pass when initial resolved tracks are insufficient", async () => {
    vi.spyOn(youtubeModule, "searchYouTube").mockResolvedValue([]);

    const resolveSpy = vi.spyOn(trackSourceResolverModule, "resolveTracksToPlayableYouTube");
    resolveSpy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          provider: "youtube",
          id: "yt-top-up",
          title: "Top Up Song",
          artist: "Top Up Artist",
          durationSec: 200,
          previewUrl: null,
          sourceUrl: "https://www.youtube.com/watch?v=yt-top-up",
        },
      ]);

    const baseTime = Date.now();
    await userLikedTrackRepository.replaceForUserProvider({
      userId: "user-2",
      provider: "spotify",
      tracks: Array.from({ length: 5 }, (_, index) => ({
        sourceId: `sp-${index + 1}`,
        addedAtMs: baseTime - index * 1000,
        title: `Song ${index + 1}`,
        artist: `Artist ${index + 1}`,
        durationMs: 180_000,
      })),
    });

    for (let index = 0; index < 5; index += 1) {
      await resolvedTrackRepository.upsert({
        provider: "spotify",
        sourceId: `sp-${index + 1}`,
        title: `Song ${index + 1}`,
        artist: `Artist ${index + 1}`,
        youtubeVideoId: null,
        durationMs: 180_000,
      });
    }

    const { fetchUserLikedTracksForProviders } = await import("../src/services/UserMusicLibrary");
    const output = await fetchUserLikedTracksForProviders({
      userId: "user-2",
      providers: ["spotify"],
      size: 1,
    });

    expect(resolveSpy).toHaveBeenCalledTimes(2);
    expect(output).toEqual([
      {
        provider: "youtube",
        id: "yt-top-up",
        title: "Top Up Song",
        artist: "Top Up Artist",
        durationSec: 200,
        previewUrl: null,
        sourceUrl: "https://www.youtube.com/watch?v=yt-top-up",
      },
    ]);
  });
});
