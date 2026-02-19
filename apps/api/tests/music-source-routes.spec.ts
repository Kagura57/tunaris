import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("music source routes", () => {
  it("returns spotify category presets", async () => {
    const response = await app.handle(new Request("http://localhost/music/spotify/categories"));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      categories: Array<{ id: string; label: string; query: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.categories.length).toBeGreaterThan(0);
  });

  it("returns spotify playlists collection payload", async () => {
    const response = await app.handle(
      new Request("http://localhost/music/spotify/playlists?category=pop&limit=6"),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      playlists: Array<{ id: string; name: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.playlists.length).toBeGreaterThanOrEqual(0);
    expect(payload.playlists.length).toBeLessThanOrEqual(6);
  });

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
});
