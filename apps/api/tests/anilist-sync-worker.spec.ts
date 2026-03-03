import { describe, expect, it } from "vitest";
import {
  buildAnimeAcronym,
  collectAniListAliasCandidates,
  normalizeAniListListStatus,
  parseAnimeCatalogId,
} from "../src/services/jobs/anilist-sync-worker";

describe("anilist sync worker", () => {
  it("maps anilist statuses to app statuses", () => {
    expect(normalizeAniListListStatus("CURRENT")).toBe("WATCHING");
    expect(normalizeAniListListStatus("COMPLETED")).toBe("COMPLETED");
    expect(normalizeAniListListStatus("PAUSED")).toBeNull();
  });

  it("builds uppercase acronyms from multi-word aliases", () => {
    expect(buildAnimeAcronym("Fullmetal Alchemist Brotherhood")).toBe("FAB");
    expect(buildAnimeAcronym("L'Attaque des Titans")).toBe("LADT");
    expect(buildAnimeAcronym("Naruto")).toBe("");
  });

  it("collects title and synonym aliases without duplicates", () => {
    const aliases = collectAniListAliasCandidates({
      media: {
        title: {
          romaji: "Shingeki no Kyojin",
          english: "Attack on Titan",
          native: "進撃の巨人",
        },
        synonyms: ["AOT", "Attack on Titan", "SnK"],
      },
    });

    expect(aliases).toEqual([
      "Shingeki no Kyojin",
      "Attack on Titan",
      "進撃の巨人",
      "AOT",
      "SnK",
    ]);
  });

  it("parses anime catalog ids from bigint-like query values", () => {
    expect(parseAnimeCatalogId("42")).toBe(42);
    expect(parseAnimeCatalogId(1337)).toBe(1337);
    expect(parseAnimeCatalogId("0")).toBeNull();
    expect(parseAnimeCatalogId("not-a-number")).toBeNull();
  });
});
