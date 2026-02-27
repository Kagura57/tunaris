import { afterEach, describe, expect, it, vi } from "vitest";
import * as httpModule from "../src/routes/music/http";
import * as anilistModule from "../src/routes/music/anilist";
import * as animethemesModule from "../src/routes/music/animethemes";
import { fetchAniListUserAnimeEntries, fetchAniListUsersOpeningTracks } from "../src/routes/music/anilist";

describe("anilist mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps AniList media list filter to CURRENT and COMPLETED", async () => {
    const fetchSpy = vi.spyOn(httpModule, "fetchJsonWithTimeout").mockResolvedValue({
      data: { MediaListCollection: { lists: [] } },
    } as Awaited<ReturnType<typeof httpModule.fetchJsonWithTimeout>>);

    await fetchAniListUserAnimeEntries("demo-user", 10);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = init?.body ?? "";
    expect(body).toContain("status_in: [CURRENT, COMPLETED]");
    expect(body).not.toContain("PAUSED");
  });

  it("builds anime tracks with identical audio/video urls from AnimeThemes", async () => {
    vi.spyOn(anilistModule, "fetchAniListUserAnimeEntries").mockResolvedValue([
      {
        id: "1",
        canonicalTitle: "Shingeki no Kyojin",
        synonyms: ["Attack on Titan", "AOT"],
      },
    ]);

    vi.spyOn(animethemesModule, "resolveAnimeThemeVideo").mockResolvedValue({
      trackId: "4744",
      animeName: "Shingeki no Kyojin",
      themeLabel: "OP1",
      sourceUrl: "https://v.animethemes.moe/ShingekiNoKyojin-OP1.webm",
      resolution: 1080,
      creditless: true,
    });

    const tracks = await fetchAniListUsersOpeningTracks(["demo-user"], 1);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      provider: "animethemes",
      id: "4744",
      title: "Shingeki no Kyojin",
      audioUrl: "https://v.animethemes.moe/ShingekiNoKyojin-OP1.webm",
      videoUrl: "https://v.animethemes.moe/ShingekiNoKyojin-OP1.webm",
      previewUrl: "https://v.animethemes.moe/ShingekiNoKyojin-OP1.webm",
      sourceUrl: "https://v.animethemes.moe/ShingekiNoKyojin-OP1.webm",
      answer: {
        canonical: "Shingeki no Kyojin",
      },
    });
  });
});
