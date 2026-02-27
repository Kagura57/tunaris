import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { animeCatalogCache } from "../src/services/AnimeCatalogCache";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("music search anime domain", () => {
  it("returns cached anime suggestions when domain=anime", async () => {
    vi.spyOn(animeCatalogCache, "search").mockResolvedValue({
      suggestions: ["Attack on Titan", "AOT"],
      cacheState: "hit",
    });

    const response = await app.handle(
      new Request("http://localhost/music/search?domain=anime&q=attack&limit=8"),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      domain: string;
      query: string;
      suggestions: string[];
      cacheState: string;
    };
    expect(payload.domain).toBe("anime");
    expect(payload.query).toBe("attack");
    expect(payload.suggestions).toEqual(["Attack on Titan", "AOT"]);
    expect(payload.cacheState).toBe("hit");
  });

  it("falls back to empty suggestions when anime lookup fails", async () => {
    vi.spyOn(animeCatalogCache, "search").mockRejectedValue(new Error("ANILIST_DOWN"));

    const response = await app.handle(
      new Request("http://localhost/music/search?domain=anime&q=naruto&limit=8"),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      domain: string;
      suggestions: string[];
      cacheState: string;
    };
    expect(payload.domain).toBe("anime");
    expect(payload.suggestions).toEqual([]);
    expect(payload.cacheState).toBe("error");
  });
});

