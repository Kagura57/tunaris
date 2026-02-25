import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicTrack } from "../src/services/music-types";

const buildSyncedUserLibraryTrackPoolMock = vi.fn();
const resolveTracksToPlayableYouTubeMock = vi.fn();

vi.mock("../src/services/MusicAggregator", () => ({
  buildSyncedUserLibraryTrackPool: buildSyncedUserLibraryTrackPoolMock,
}));

vi.mock("../src/services/TrackSourceResolver", () => ({
  resolveTracksToPlayableYouTube: resolveTracksToPlayableYouTubeMock,
}));

describe("fetchUserLikedTracksForProviders", () => {
  beforeEach(() => {
    buildSyncedUserLibraryTrackPoolMock.mockReset();
    resolveTracksToPlayableYouTubeMock.mockReset();
  });

  it("returns playable tracks without throwing when logging includes userId", async () => {
    const mergedTrack: MusicTrack = {
      provider: "spotify",
      id: "sp-1",
      title: "Song",
      artist: "Artist",
      previewUrl: null,
      sourceUrl: "https://open.spotify.com/track/sp-1",
    };
    const playableTrack: MusicTrack = {
      provider: "youtube",
      id: "yt-1",
      title: "Song",
      artist: "Artist",
      previewUrl: null,
      sourceUrl: "https://www.youtube.com/watch?v=yt-1",
    };

    buildSyncedUserLibraryTrackPoolMock.mockResolvedValue([mergedTrack]);
    resolveTracksToPlayableYouTubeMock.mockResolvedValue([playableTrack]);

    const { fetchUserLikedTracksForProviders } = await import("../src/services/UserMusicLibrary");
    const output = await fetchUserLikedTracksForProviders({
      userId: " user-1 ",
      providers: ["spotify"],
      size: 10,
    });

    expect(buildSyncedUserLibraryTrackPoolMock).toHaveBeenCalledWith({
      userId: "user-1",
      providers: ["spotify"],
      size: 30,
    });
    expect(resolveTracksToPlayableYouTubeMock).toHaveBeenCalledTimes(1);
    expect(output).toEqual([playableTrack]);
  });
});

