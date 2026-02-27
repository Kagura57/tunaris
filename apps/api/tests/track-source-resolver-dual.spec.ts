import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as spotifyModule from "../src/routes/music/spotify";
import * as youtubeModule from "../src/routes/music/youtube";
import { resolveTrackPoolFromSource } from "../src/services/TrackSourceResolver";
import { resolvedTrackRepository } from "../src/repositories/ResolvedTrackRepository";

describe("track source resolver dual source", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resolvedTrackRepository.clearMemory();

    vi.spyOn(spotifyModule, "fetchSpotifyPopularTracks").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resolvedTrackRepository.clearMemory();
  });

  it("resolves spotify playlist tracks with distinct audio and video urls", async () => {
    vi.spyOn(spotifyModule, "fetchSpotifyPlaylistTracks").mockResolvedValue([
      {
        provider: "spotify",
        id: "sp-dual-1",
        title: "Dual Song",
        artist: "Dual Artist",
        previewUrl: "https://cdn.example.com/dual-song-preview.mp3",
        sourceUrl: "https://open.spotify.com/track/sp-dual-1",
      },
    ]);

    vi.spyOn(youtubeModule, "searchYouTube").mockResolvedValue([
      {
        provider: "youtube",
        id: "yt-dual-1",
        title: "Dual Song Official Video",
        artist: "Dual Artist",
        previewUrl: null,
        sourceUrl: "https://www.youtube.com/watch?v=yt-dual-1",
      },
    ]);

    const tracks = await resolveTrackPoolFromSource({
      categoryQuery: "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
      size: 1,
    });

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      provider: "youtube",
      id: "yt-dual-1",
      title: "Dual Song",
      artist: "Dual Artist",
      audioUrl: "https://cdn.example.com/dual-song-preview.mp3",
      videoUrl: "https://www.youtube.com/watch?v=yt-dual-1",
      previewUrl: "https://cdn.example.com/dual-song-preview.mp3",
      sourceUrl: "https://www.youtube.com/watch?v=yt-dual-1",
    });
  });

  it("falls back to youtube video url as audio when no preview exists", async () => {
    vi.spyOn(spotifyModule, "fetchSpotifyPlaylistTracks").mockResolvedValue([
      {
        provider: "spotify",
        id: "sp-dual-2",
        title: "No Preview Song",
        artist: "No Preview Artist",
        previewUrl: null,
        sourceUrl: "https://open.spotify.com/track/sp-dual-2",
      },
    ]);

    vi.spyOn(youtubeModule, "searchYouTube").mockResolvedValue([
      {
        provider: "youtube",
        id: "yt-dual-2",
        title: "No Preview Song Official Video",
        artist: "No Preview Artist",
        previewUrl: null,
        sourceUrl: "https://www.youtube.com/watch?v=yt-dual-2",
      },
    ]);

    const tracks = await resolveTrackPoolFromSource({
      categoryQuery: "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
      size: 1,
    });

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      provider: "youtube",
      id: "yt-dual-2",
      audioUrl: "https://www.youtube.com/watch?v=yt-dual-2",
      videoUrl: "https://www.youtube.com/watch?v=yt-dual-2",
      previewUrl: "https://www.youtube.com/watch?v=yt-dual-2",
      sourceUrl: "https://www.youtube.com/watch?v=yt-dual-2",
    });
  });
});
