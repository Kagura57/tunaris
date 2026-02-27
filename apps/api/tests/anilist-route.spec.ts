import { afterEach, describe, expect, it, vi } from "vitest";
import * as httpModule from "../src/routes/music/http";
import { fetchAniListUserAnimeEntries } from "../src/routes/music/anilist";

describe("anilist route helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries AniList with CURRENT and COMPLETED only", async () => {
    const fetchSpy = vi.spyOn(httpModule, "fetchJsonWithTimeout").mockResolvedValue({
      data: { MediaListCollection: { lists: [] } },
    } as Awaited<ReturnType<typeof httpModule.fetchJsonWithTimeout>>);

    await fetchAniListUserAnimeEntries("demo-user", 10);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const init = fetchSpy.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = init?.body ?? "";
    expect(body).toContain("status_in: [CURRENT, COMPLETED]");
    expect(body).not.toContain("REPEATING");
  });

  it("returns canonical titles with normalized synonyms", async () => {
    vi.spyOn(httpModule, "fetchJsonWithTimeout").mockResolvedValue({
      data: {
        MediaListCollection: {
          lists: [
            {
              entries: [
                {
                  media: {
                    id: 1,
                    title: { romaji: "Shingeki no Kyojin", english: "Attack on Titan", native: null },
                    synonyms: ["AOT", "Attack on Titan", "  aot "],
                  },
                },
                {
                  media: {
                    id: 2,
                    title: { romaji: "Fullmetal Alchemist: Brotherhood", english: null, native: null },
                    synonyms: ["FMAB"],
                  },
                },
              ],
            },
          ],
        },
      },
    } as Awaited<ReturnType<typeof httpModule.fetchJsonWithTimeout>>);

    const entries = await fetchAniListUserAnimeEntries("demo-user", 10);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      id: "1",
      canonicalTitle: "Shingeki no Kyojin",
      synonyms: ["Shingeki no Kyojin", "AOT", "Attack on Titan"],
    });
    expect(entries[1]).toEqual({
      id: "2",
      canonicalTitle: "Fullmetal Alchemist: Brotherhood",
      synonyms: ["Fullmetal Alchemist: Brotherhood", "FMAB"],
    });
  });
});
