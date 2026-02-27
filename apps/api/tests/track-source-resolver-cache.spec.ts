import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as anilistModule from "../src/routes/music/anilist";
import * as deezerModule from "../src/routes/music/deezer";
import * as spotifyModule from "../src/routes/music/spotify";
import * as youtubeModule from "../src/routes/music/youtube";
import * as aggregatorModule from "../src/services/MusicAggregator";
import { resolveTrackPoolFromSource, resolveTracksToPlayableYouTube } from "../src/services/TrackSourceResolver";
import { resolvedTrackRepository } from "../src/repositories/ResolvedTrackRepository";

let fetchSpotifyPlaylistTracksMock: ReturnType<typeof vi.fn>;
let fetchDeezerPlaylistTracksMock: ReturnType<typeof vi.fn>;
let searchYouTubeMock: ReturnType<typeof vi.fn>;
let buildTrackPoolMock: ReturnType<typeof vi.fn>;

describe("track source resolver cache behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resolvedTrackRepository.clearMemory();

    fetchSpotifyPlaylistTracksMock = vi
      .spyOn(spotifyModule, "fetchSpotifyPlaylistTracks")
      .mockResolvedValue([
        {
          provider: "spotify",
          id: "sp-cache-1",
          title: "Cache Song",
          artist: "Cache Artist",
          previewUrl: "https://cdn.example/cache.mp3",
          sourceUrl: "https://open.spotify.com/track/sp-cache-1",
        },
      ]);

    vi.spyOn(spotifyModule, "fetchSpotifyPopularTracks").mockResolvedValue([]);

    fetchDeezerPlaylistTracksMock = vi
      .spyOn(deezerModule, "fetchDeezerPlaylistTracks")
      .mockResolvedValue([]);

    vi.spyOn(deezerModule, "fetchDeezerChartTracks").mockResolvedValue([]);

    vi.spyOn(anilistModule, "fetchAniListUsersOpeningTracks").mockResolvedValue([]);

    searchYouTubeMock = vi.spyOn(youtubeModule, "searchYouTube").mockResolvedValue([]);

    buildTrackPoolMock = vi
      .spyOn(aggregatorModule, "buildTrackPool")
      .mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resolvedTrackRepository.clearMemory();
  });

  it("uses persistent resolved-track cache before calling youtube search", async () => {
    fetchSpotifyPlaylistTracksMock.mockResolvedValue([
      {
        provider: "spotify",
        id: "sp-db-cache-1",
        title: "DB Cache Song",
        artist: "DB Cache Artist",
        previewUrl: null,
        sourceUrl: "https://open.spotify.com/track/sp-db-cache-1",
      },
    ]);

    const cacheGetSpy = vi
      .spyOn(resolvedTrackRepository, "getBySource")
      .mockResolvedValue({
        provider: "spotify",
        sourceId: "sp-db-cache-1",
        title: "DB Cache Song",
        artist: "DB Cache Artist",
        youtubeVideoId: "yt-db-cache-1",
        durationMs: 201_000,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

    const resolved = await resolveTrackPoolFromSource({
      categoryQuery: "spotify:playlist:cache123",
      size: 1,
    });

    expect(cacheGetSpy).toHaveBeenCalledWith("spotify", "sp-db-cache-1");
    expect(searchYouTubeMock).not.toHaveBeenCalled();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      provider: "youtube",
      id: "yt-db-cache-1",
      title: "DB Cache Song",
      artist: "DB Cache Artist",
    });
  });

  it("does not cache failed youtube resolutions as permanent null", async () => {
    vi.spyOn(resolvedTrackRepository, "getBySource").mockResolvedValue(null);

    let youtubeCalls = 0;
    searchYouTubeMock.mockImplementation(async () => {
      youtubeCalls += 1;
      if (youtubeCalls <= 8) return [];
      return [
        {
          provider: "youtube",
          id: "yt-cache-1",
          title: "Cache Song official audio",
          artist: "Cache Artist topic",
          previewUrl: null,
          sourceUrl: "https://www.youtube.com/watch?v=yt-cache-1",
        },
      ];
    });

    const first = await resolveTrackPoolFromSource({
      categoryQuery: "spotify:playlist:cache123",
      size: 1,
    });
    expect(first).toHaveLength(0);

    const second = await resolveTrackPoolFromSource({
      categoryQuery: "spotify:playlist:cache123",
      size: 1,
    });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      provider: "youtube",
      id: "yt-cache-1",
    });
  });

  it("prioritizes official clip from artist channel over non-artist channel matches", async () => {
    vi.spyOn(resolvedTrackRepository, "getBySource").mockResolvedValue(null);
    fetchSpotifyPlaylistTracksMock.mockResolvedValue([
      {
        provider: "spotify",
        id: "sp-priority-1",
        title: "Preference Song (feat. Someone)",
        artist: "Exact Artist",
        previewUrl: null,
        sourceUrl: "https://open.spotify.com/track/sp-priority-1",
      },
    ]);

    searchYouTubeMock.mockImplementation(async (query: string) => {
      const normalized = query.toLowerCase();
      if (normalized.includes("official video") && normalized.includes("feat")) {
        return [
          {
            provider: "youtube",
            id: "yt-clip-fan",
            title: "Preference Song Official Video",
            artist: "Fan Uploads Channel",
            previewUrl: null,
            sourceUrl: "https://www.youtube.com/watch?v=yt-clip-fan",
          },
        ];
      }
      if (normalized.includes("official video")) {
        return [
          {
            provider: "youtube",
            id: "yt-clip-artist",
            title: "Preference Song Official Video",
            artist: "Exact Artist",
            previewUrl: null,
            sourceUrl: "https://www.youtube.com/watch?v=yt-clip-artist",
          },
        ];
      }
      return [];
    });

    const resolved = await resolveTrackPoolFromSource({
      categoryQuery: "spotify:playlist:cache123",
      size: 1,
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      provider: "youtube",
      id: "yt-clip-artist",
      title: "Preference Song (feat. Someone)",
      artist: "Exact Artist",
    });
  });

  it("falls back to official audio when no official clip candidate is found", async () => {
    vi.spyOn(resolvedTrackRepository, "getBySource").mockResolvedValue(null);
    fetchSpotifyPlaylistTracksMock.mockResolvedValue([
      {
        provider: "spotify",
        id: "sp-audio-1",
        title: "Audio Fallback Song",
        artist: "Audio Artist",
        previewUrl: null,
        sourceUrl: "https://open.spotify.com/track/sp-audio-1",
      },
    ]);

    searchYouTubeMock.mockImplementation(async (query: string) => {
      const normalized = query.toLowerCase();
      if (
        normalized.includes("official video") ||
        normalized.includes("official clip") ||
        normalized.includes("music video")
      ) {
        return [
          {
            provider: "youtube",
            id: "yt-lyrics-only",
            title: "Audio Fallback Song Lyrics",
            artist: "Random Channel",
            previewUrl: null,
            sourceUrl: "https://www.youtube.com/watch?v=yt-lyrics-only",
          },
        ];
      }
      if (normalized.includes("official audio")) {
        return [
          {
            provider: "youtube",
            id: "yt-official-audio",
            title: "Audio Fallback Song (Official Audio)",
            artist: "Audio Artist",
            previewUrl: null,
            sourceUrl: "https://www.youtube.com/watch?v=yt-official-audio",
          },
        ];
      }
      return [];
    });

    const resolved = await resolveTrackPoolFromSource({
      categoryQuery: "spotify:playlist:cache123",
      size: 1,
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      provider: "youtube",
      id: "yt-official-audio",
      title: "Audio Fallback Song",
      artist: "Audio Artist",
    });
    const calledQueries = searchYouTubeMock.mock.calls.map((call) => String(call[0]).toLowerCase());
    expect(calledQueries.some((query) => query.includes("audio artist - audio fallback song"))).toBe(false);
  });

  it("prefers exact japanese-title overlap over generic artist MV candidates", async () => {
    vi.spyOn(resolvedTrackRepository, "getBySource").mockResolvedValue(null);
    fetchSpotifyPlaylistTracksMock.mockResolvedValue([
      {
        provider: "spotify",
        id: "sp-jp-1",
        title: "修羅",
        artist: "DOES",
        previewUrl: null,
        sourceUrl: "https://open.spotify.com/track/sp-jp-1",
      },
    ]);

    searchYouTubeMock.mockImplementation(async (query: string) => {
      const normalized = query.toLowerCase();
      if (!normalized.includes("official video")) return [];
      return [
        {
          provider: "youtube",
          id: "yt-wrong-jp-1",
          title: "JUMP MV / 銀魂 ×「修羅」",
          artist: "DOES",
          previewUrl: null,
          sourceUrl: "https://www.youtube.com/watch?v=yt-wrong-jp-1",
        },
        {
          provider: "youtube",
          id: "yt-correct-jp-1",
          title: "修羅 (Official Video)",
          artist: "DOES",
          previewUrl: null,
          sourceUrl: "https://www.youtube.com/watch?v=yt-correct-jp-1",
        },
      ];
    });

    const resolved = await resolveTrackPoolFromSource({
      categoryQuery: "spotify:playlist:cache123",
      size: 1,
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      provider: "youtube",
      id: "yt-correct-jp-1",
      title: "修羅",
      artist: "DOES",
    });
  });

  it("prefers official audio when only off-version live clip is available", async () => {
    vi.spyOn(resolvedTrackRepository, "getBySource").mockResolvedValue(null);
    fetchSpotifyPlaylistTracksMock.mockResolvedValue([
      {
        provider: "spotify",
        id: "sp-arch-1",
        title: "The Distant Blue",
        artist: "Architects",
        previewUrl: null,
        sourceUrl: "https://open.spotify.com/track/sp-arch-1",
      },
    ]);

    searchYouTubeMock.mockImplementation(async (query: string) => {
      const normalized = query.toLowerCase();
      if (normalized.includes("official video")) {
        return [
          {
            provider: "youtube",
            id: "yt-arch-live-1",
            title: "Architects - The Distant Blue (Live) Official Video",
            artist: "Architects",
            previewUrl: null,
            sourceUrl: "https://www.youtube.com/watch?v=yt-arch-live-1",
          },
        ];
      }
      if (normalized.includes("official audio")) {
        return [
          {
            provider: "youtube",
            id: "yt-arch-audio-1",
            title: "Architects - The Distant Blue (Official Audio)",
            artist: "Architects",
            previewUrl: null,
            sourceUrl: "https://www.youtube.com/watch?v=yt-arch-audio-1",
          },
        ];
      }
      return [
        {
          provider: "youtube",
          id: "yt-arch-live-fallback",
          title: "Architects - The Distant Blue live at old show",
          artist: "Architects",
          previewUrl: null,
          sourceUrl: "https://www.youtube.com/watch?v=yt-arch-live-fallback",
        },
      ];
    });

    const resolved = await resolveTrackPoolFromSource({
      categoryQuery: "spotify:playlist:cache123",
      size: 1,
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      provider: "youtube",
      id: "yt-arch-audio-1",
      title: "The Distant Blue",
      artist: "Architects",
    });
  });

  it("avoids short-version clip when artist-matched full version exists", async () => {
    vi.spyOn(resolvedTrackRepository, "getBySource").mockResolvedValue(null);
    fetchSpotifyPlaylistTracksMock.mockResolvedValue([
      {
        provider: "spotify",
        id: "sp-stardom-1",
        title: "STARDOM",
        artist: "King Gnu",
        previewUrl: null,
        sourceUrl: "https://open.spotify.com/track/sp-stardom-1",
      },
    ]);

    searchYouTubeMock.mockImplementation(async (query: string) => {
      const normalized = query.toLowerCase();
      if (normalized.includes("official video")) {
        return [
          {
            provider: "youtube",
            id: "yt-stardom-short-1",
            title: "Stardom MV Short ver",
            artist: "Some Channel",
            previewUrl: null,
            sourceUrl: "https://www.youtube.com/watch?v=yt-stardom-short-1",
          },
        ];
      }
      if (normalized.includes("official audio")) {
        return [
          {
            provider: "youtube",
            id: "yt-stardom-audio-1",
            title: "King Gnu - STARDOM (Official Audio)",
            artist: "King Gnu",
            previewUrl: null,
            sourceUrl: "https://www.youtube.com/watch?v=yt-stardom-audio-1",
          },
        ];
      }
      return [];
    });

    const resolved = await resolveTrackPoolFromSource({
      categoryQuery: "spotify:playlist:cache123",
      size: 1,
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      provider: "youtube",
      id: "yt-stardom-audio-1",
      title: "STARDOM",
      artist: "King Gnu",
    });
  });

  it("filters ad-like source tracks before youtube prioritization", async () => {
    fetchSpotifyPlaylistTracksMock.mockResolvedValue([
      {
        provider: "spotify",
        id: "sp-ad-1",
        title: "Annonce Publicitaire",
        artist: "Deezer Ads",
        previewUrl: "https://cdn.example/ad.mp3",
        sourceUrl: "https://open.spotify.com/track/sp-ad-1",
      },
      {
        provider: "spotify",
        id: "sp-real-1",
        title: "Real Song",
        artist: "Real Artist",
        previewUrl: "https://cdn.example/real.mp3",
        sourceUrl: "https://open.spotify.com/track/sp-real-1",
      },
      {
        provider: "spotify",
        id: "sp-spam-1",
        title: "Spotify This App Best Free Music Alternative",
        artist: "Sunday Cal",
        previewUrl: "https://cdn.example/spam.mp3",
        sourceUrl: "https://open.spotify.com/track/sp-spam-1",
      },
    ]);

    searchYouTubeMock.mockImplementation(async (query: string) => {
      if (query.toLowerCase().includes("real song")) {
        return [
          {
            provider: "youtube",
            id: "yt-real-1",
            title: "Real Song (Official Audio)",
            artist: "Real Artist",
            previewUrl: null,
            sourceUrl: "https://www.youtube.com/watch?v=yt-real-1",
          },
        ];
      }

      if (query.toLowerCase().includes("annonce")) {
        return [
          {
            provider: "youtube",
            id: "yt-ad-1",
            title: "Publicite",
            artist: "Ads Channel",
            previewUrl: null,
            sourceUrl: "https://www.youtube.com/watch?v=yt-ad-1",
          },
        ];
      }

      if (query.toLowerCase().includes("alternative")) {
        return [
          {
            provider: "youtube",
            id: "yt-spam-1",
            title: "Best Free Music Alternative",
            artist: "Ad Channel",
            previewUrl: null,
            sourceUrl: "https://www.youtube.com/watch?v=yt-spam-1",
          },
        ];
      }

      return [];
    });

    const resolved = await resolveTrackPoolFromSource({
      categoryQuery: "spotify:playlist:cache123",
      size: 2,
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      provider: "youtube",
      id: "yt-real-1",
      title: "Real Song",
      artist: "Real Artist",
    });
  });

  it("does not inject generic deezer query fillers for deezer playlist sources", async () => {
    fetchSpotifyPlaylistTracksMock.mockResolvedValue([]);
    fetchDeezerPlaylistTracksMock.mockResolvedValue([
      {
        provider: "deezer",
        id: "dz-real-1",
        title: "Real Deezer Song",
        artist: "Real Artist",
        previewUrl: "https://cdn.example/dz-real.mp3",
        sourceUrl: "https://www.deezer.com/track/dz-real-1",
      },
    ]);

    searchYouTubeMock.mockImplementation(async (query: string) => {
      if (query.toLowerCase().includes("real deezer song")) {
        return [
          {
            provider: "youtube",
            id: "yt-real-dz-1",
            title: "Real Deezer Song (Official Audio)",
            artist: "Real Artist",
            previewUrl: null,
            sourceUrl: "https://www.youtube.com/watch?v=yt-real-dz-1",
          },
        ];
      }
      if (query.toLowerCase().includes("deezer hits")) {
        return [
          {
            provider: "youtube",
            id: "yt-ad-dz-1",
            title: "Spotify This App Best Free Music Alternative",
            artist: "Ad Channel",
            previewUrl: null,
            sourceUrl: "https://www.youtube.com/watch?v=yt-ad-dz-1",
          },
        ];
      }
      return [];
    });

    const resolved = await resolveTrackPoolFromSource({
      categoryQuery: "deezer:playlist:3155776842",
      size: 2,
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      provider: "youtube",
      id: "yt-real-dz-1",
      title: "Real Deezer Song",
      artist: "Real Artist",
    });
    const calledQueries = searchYouTubeMock.mock.calls.map((call) => String(call[0]).toLowerCase());
    expect(calledQueries.some((query) => query.includes("deezer hits"))).toBe(false);
  });

  it("does not invent fallback tracks when playlist source is empty", async () => {
    fetchDeezerPlaylistTracksMock.mockResolvedValue([]);
    buildTrackPoolMock.mockResolvedValue([
      {
        provider: "youtube",
        id: "yt-filler-1",
        title: "Popular Hits Filler",
        artist: "Auto",
        previewUrl: null,
        sourceUrl: "https://www.youtube.com/watch?v=yt-filler-1",
      },
    ]);

    const resolved = await resolveTrackPoolFromSource({
      categoryQuery: "deezer:playlist:3155776842",
      size: 4,
    });

    expect(resolved).toEqual([]);
    expect(buildTrackPoolMock).not.toHaveBeenCalled();
  });

  it("resolves more than three tracks when source has enough entries", async () => {
    fetchDeezerPlaylistTracksMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        provider: "deezer" as const,
        id: `dz-many-${index + 1}`,
        title: `Many Song ${index + 1}`,
        artist: "Many Artist",
        previewUrl: `https://cdn.example/${index + 1}.mp3`,
        sourceUrl: `https://www.deezer.com/track/${index + 1}`,
      })),
    );

    searchYouTubeMock.mockImplementation(async (query: string) => {
      const match = query.match(/many song (\d+)/i);
      if (!match) return [];
      const id = `yt-many-${match[1]}`;
      return [
        {
          provider: "youtube",
          id,
          title: `Many Song ${match[1]} Official Audio`,
          artist: "Many Artist",
          previewUrl: null,
          sourceUrl: `https://www.youtube.com/watch?v=${id}`,
        },
      ];
    });

    const resolved = await resolveTrackPoolFromSource({
      categoryQuery: "deezer:playlist:3155776842",
      size: 8,
    });

    expect(resolved.length).toBeGreaterThan(3);
    expect(resolved.length).toBeLessThanOrEqual(8);
  });

  it("iterates across playlist candidates until requested rounds are filled", async () => {
    fetchSpotifyPlaylistTracksMock.mockResolvedValue([]);
    fetchDeezerPlaylistTracksMock.mockResolvedValue(
      Array.from({ length: 50 }, (_, index) => ({
        provider: "deezer" as const,
        id: `dz-playlist-${index + 1}`,
        title: `Playlist Song ${index + 1}`,
        artist: "Playlist Artist",
        previewUrl: `https://cdn.example/p-${index + 1}.mp3`,
        sourceUrl: `https://www.deezer.com/track/${index + 1}`,
      })),
    );

    searchYouTubeMock.mockImplementation(async (query: string) => {
      const match = query.match(/playlist song (\d+)/i);
      if (!match) return [];
      const index = Number.parseInt(match[1] ?? "0", 10);
      if (index <= 40) return [];

      const id = `yt-playlist-${index}`;
      return [
        {
          provider: "youtube",
          id,
          title: `Playlist Song ${index} Official Audio`,
          artist: "Playlist Artist",
          previewUrl: null,
          sourceUrl: `https://www.youtube.com/watch?v=${id}`,
        },
      ];
    });

    const resolved = await resolveTrackPoolFromSource({
      categoryQuery: "deezer:playlist:3155776842",
      size: 10,
    });

    expect(resolved).toHaveLength(10);
    expect(new Set(resolved.map((track) => track.id)).size).toBe(10);
  });

  it("limits direct track resolution concurrency to chunk size", async () => {
    fetchSpotifyPlaylistTracksMock.mockResolvedValue([]);
    fetchDeezerPlaylistTracksMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        provider: "deezer" as const,
        id: `dz-chunk-${index + 1}`,
        title: `Chunk Song ${index + 1}`,
        artist: "Chunk Artist",
        previewUrl: `https://cdn.example/chunk-${index + 1}.mp3`,
        sourceUrl: `https://www.deezer.com/track/chunk-${index + 1}`,
      })),
    );

    let inFlight = 0;
    let maxInFlight = 0;
    searchYouTubeMock.mockImplementation(async (query: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight = Math.max(0, inFlight - 1);
      const match = query.match(/chunk song (\d+)/i);
      if (!match) return [];
      const id = `yt-chunk-${match[1]}`;
      return [
        {
          provider: "youtube",
          id,
          title: `Chunk Song ${match[1]} Official Audio`,
          artist: "Chunk Artist",
          previewUrl: null,
          sourceUrl: `https://www.youtube.com/watch?v=${id}`,
        },
      ];
    });

    const resolved = await resolveTrackPoolFromSource({
      categoryQuery: "deezer:playlist:3155776842",
      size: 10,
    });

    expect(resolved).toHaveLength(10);
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });

  it("limits direct resolution budget to requested size for liked-track resolution", async () => {
    searchYouTubeMock.mockResolvedValue([]);

    const tracks = Array.from({ length: 10 }, (_, index) => ({
      provider: "spotify" as const,
      id: `sp-budget-${index + 1}`,
      title: `Budget Song ${index + 1}`,
      artist: "Budget Artist",
      previewUrl: null,
      sourceUrl: `https://open.spotify.com/track/sp-budget-${index + 1}`,
    }));

    const resolved = await resolveTracksToPlayableYouTube(tracks, 1);
    expect(resolved).toEqual([]);
    expect(searchYouTubeMock.mock.calls.length).toBeGreaterThan(0);
    expect(searchYouTubeMock.mock.calls.length).toBeLessThanOrEqual(8);
  });
});
