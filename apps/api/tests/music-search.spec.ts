import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("music search route", () => {
  it("returns 400 when query is missing", async () => {
    const response = await app.handle(new Request("http://localhost/music/search"));
    expect(response.status).toBe(400);
  });

  it("returns unified provider payload", async () => {
    const response = await app.handle(new Request("http://localhost/music/search?q=anime&limit=5"));
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      query: string;
      limit: number;
      results: Record<string, unknown>;
    };

    expect(payload.query).toBe("anime");
    expect(payload.limit).toBe(5);
    expect(Object.keys(payload.results).sort()).toEqual(
      ["apple-music", "deezer", "spotify", "tidal", "youtube", "ytmusic"].sort(),
    );
  });
});
