import { afterEach, describe, expect, it, vi } from "vitest";
import type { MusicTrack } from "../src/services/music-types";
import { resolveTrackPoolFromSource } from "../src/services/TrackSourceResolver";
import * as anilistModule from "../src/routes/music/anilist";
import * as animethemesModule from "../src/routes/music/animethemes";

const ANIME_SOURCE_TRACKS: MusicTrack[] = [
  {
    provider: "youtube",
    id: "yt-aot-op1",
    title: "Guren no Yumiya",
    artist: "Linked Horizon",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=yt-aot-op1",
    answer: {
      canonical: "Attack on Titan",
      aliases: ["Shingeki no Kyojin", "AOT"],
      mode: "anime",
    },
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("animethemes resolver", () => {
  it("prefers animethemes webm for AniList sources", async () => {
    vi.spyOn(anilistModule, "fetchAniListUsersOpeningTracks").mockResolvedValue(ANIME_SOURCE_TRACKS);
    vi.spyOn(animethemesModule, "resolveAnimeThemeVideo").mockResolvedValue({
      trackId: "4744",
      animeName: "Shingeki no Kyojin",
      themeLabel: "OP1",
      sourceUrl: "https://v.animethemes.moe/ShingekiNoKyojin-OP1.webm",
      resolution: 1080,
      creditless: true,
    });

    const tracks = await resolveTrackPoolFromSource({
      categoryQuery: "anilist:users:demo-user",
      size: 1,
    });

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      provider: "animethemes",
      id: "4744",
      sourceUrl: "https://v.animethemes.moe/ShingekiNoKyojin-OP1.webm",
      answer: {
        canonical: "Attack on Titan",
      },
    });
  });

  it("falls back to YouTube-backed tracks when animethemes has no match", async () => {
    vi.spyOn(anilistModule, "fetchAniListUsersOpeningTracks").mockResolvedValue(ANIME_SOURCE_TRACKS);
    vi.spyOn(animethemesModule, "resolveAnimeThemeVideo").mockResolvedValue(null);

    const tracks = await resolveTrackPoolFromSource({
      categoryQuery: "anilist:users:demo-user",
      size: 1,
    });

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      provider: "youtube",
      id: "yt-aot-op1",
      answer: {
        canonical: "Attack on Titan",
      },
    });
  });
});

