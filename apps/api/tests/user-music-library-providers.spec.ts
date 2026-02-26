import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as youtubeModule from "../src/routes/music/youtube";
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
});
