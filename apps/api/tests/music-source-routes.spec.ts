import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import * as deezerModule from "../src/routes/music/deezer";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("music source routes", () => {
  it("returns 400 when source is missing", async () => {
    const response = await app.handle(new Request("http://localhost/music/source/resolve"));
    expect(response.status).toBe(400);
  });

  it("resolves source metadata for free search", async () => {
    const response = await app.handle(
      new Request("http://localhost/music/source/resolve?source=popular%20hits&size=6"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      parsed: { type: string };
      count: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.parsed.type).toBe("search");
    expect(payload.count).toBeGreaterThanOrEqual(0);
    expect(payload.count).toBeLessThanOrEqual(6);
  });

  it("returns 400 when AniList users are missing", async () => {
    const response = await app.handle(new Request("http://localhost/music/anilist/titles"));
    expect(response.status).toBe(400);
  });

  it("returns Deezer-only playlist results in unified format", async () => {
    vi.spyOn(deezerModule, "searchDeezerPlaylists").mockResolvedValue([
      {
        provider: "deezer",
        id: "dz123",
        name: "Top Deezer",
        description: "desc",
        imageUrl: "https://cdn.example/dz.jpg",
        externalUrl: "https://www.deezer.com/playlist/dz123",
        owner: "Deezer",
        trackCount: 80,
      },
    ]);

    const response = await app.handle(
      new Request("http://localhost/music/playlists/search?q=top%20hits&limit=24"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      playlists: Array<{
        provider: "deezer";
        id: string;
        name: string;
        trackCount: number | null;
        sourceQuery: string;
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.playlists.length).toBe(1);
    expect(payload.playlists[0]).toMatchObject({
      provider: "deezer",
      id: "dz123",
      trackCount: 80,
      sourceQuery: "deezer:playlist:dz123",
    });
  });

  it("returns empty results when Deezer fails", async () => {
    vi.spyOn(deezerModule, "searchDeezerPlaylists").mockRejectedValue(new Error("DEEZER_BROKEN"));

    const response = await app.handle(
      new Request("http://localhost/music/playlists/search?q=ok%20search&limit=24"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      playlists: Array<{ provider: "deezer"; id: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.playlists).toEqual([]);
  });

  it("does not crash when Deezer returns malformed items and still returns valid playlists", async () => {
    vi.spyOn(deezerModule, "searchDeezerPlaylists").mockResolvedValue([
      {
        id: undefined,
        name: "Broken Deezer Payload",
        description: "broken",
        imageUrl: null,
        externalUrl: "https://www.deezer.com/playlist/broken",
        owner: "deezer",
        trackCount: null,
      } as unknown as Awaited<ReturnType<typeof deezerModule.searchDeezerPlaylists>>[number],
      {
        provider: "deezer",
        id: "dz-valid",
        name: "Deezer Valid",
        description: "",
        imageUrl: null,
        externalUrl: "https://www.deezer.com/playlist/dz-valid",
        owner: "Deezer",
        trackCount: 42,
      },
    ]);

    const response = await app.handle(
      new Request("http://localhost/music/playlists/search?q=payload%20shape&limit=24"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      playlists: Array<{ provider: "deezer"; id: string; name: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.playlists).toEqual([
      expect.objectContaining({ provider: "deezer", id: "dz-valid", name: "Deezer Valid" }),
    ]);
    expect(payload.playlists.some((item) => item.name === "Broken Deezer Payload")).toBe(false);
  });

  it("returns quickly with empty list when Deezer hangs beyond timeout", async () => {
    const originalTimeout = process.env.PLAYLIST_SEARCH_PROVIDER_TIMEOUT_MS;
    process.env.PLAYLIST_SEARCH_PROVIDER_TIMEOUT_MS = "50";

    try {
      vi.spyOn(deezerModule, "searchDeezerPlaylists").mockImplementation(
        () => new Promise(() => {}) as ReturnType<typeof deezerModule.searchDeezerPlaylists>,
      );

      const startedAt = Date.now();
      const response = await app.handle(
        new Request("http://localhost/music/playlists/search?q=timeout%20case&limit=24"),
      );
      const durationMs = Date.now() - startedAt;

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        ok: boolean;
        playlists: Array<{ provider: "deezer"; id: string; name: string }>;
      };
      expect(payload.ok).toBe(true);
      expect(payload.playlists).toEqual([]);
      expect(durationMs).toBeLessThan(1500);
    } finally {
      if (typeof originalTimeout === "string") {
        process.env.PLAYLIST_SEARCH_PROVIDER_TIMEOUT_MS = originalTimeout;
      } else {
        delete process.env.PLAYLIST_SEARCH_PROVIDER_TIMEOUT_MS;
      }
    }
  });
});
