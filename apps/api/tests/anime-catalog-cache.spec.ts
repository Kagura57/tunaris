import { describe, expect, it } from "vitest";
import { AnimeCatalogCache } from "../src/services/AnimeCatalogCache";

describe("anime catalog cache", () => {
  it("returns suggestions from in-memory catalog", async () => {
    const cache = new AnimeCatalogCache({
      queryTtlMs: 60_000,
      maxCatalogEntries: 10,
    });
    cache.setCatalogForTests([
      {
        id: "1",
        title: "Attack on Titan",
        synonyms: ["Shingeki no Kyojin", "AOT"],
      },
      {
        id: "2",
        title: "Fullmetal Alchemist: Brotherhood",
        synonyms: ["FMAB"],
      },
    ]);

    const first = await cache.search("attack", 5);
    const second = await cache.search("attack", 5);

    expect(first.suggestions).toContain("Attack on Titan");
    expect(first.cacheState).toBe("miss");
    expect(second.cacheState).toBe("hit");
  });

  it("supports fuzzy anime matching", async () => {
    const cache = new AnimeCatalogCache({
      queryTtlMs: 60_000,
      maxCatalogEntries: 10,
    });
    cache.setCatalogForTests([
      {
        id: "1",
        title: "Shingeki no Kyojin",
        synonyms: ["Attack on Titan", "AOT"],
      },
      {
        id: "2",
        title: "Naruto",
        synonyms: [],
      },
    ]);

    const result = await cache.search("shingeki", 5);
    expect(result.suggestions[0]).toBe("Shingeki no Kyojin");
  });
});
