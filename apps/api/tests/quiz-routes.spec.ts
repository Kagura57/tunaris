import { afterEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/client";
import { app } from "../src/index";

describe("quiz routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DATABASE_URL;
  });

  it("lists public rooms", async () => {
    const createRes = await app.handle(new Request("http://localhost/quiz/create", { method: "POST" }));
    const created = (await createRes.json()) as { roomCode: string };

    const publicRes = await app.handle(new Request("http://localhost/quiz/public"));
    expect(publicRes.status).toBe(200);
    const payload = (await publicRes.json()) as {
      ok: boolean;
      rooms: Array<{ roomCode: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.rooms.some((room) => room.roomCode === created.roomCode)).toBe(true);
  });

  it("creates a room", async () => {
    const res = await app.handle(new Request("http://localhost/quiz/create", { method: "POST" }));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { roomCode: string };
    expect(payload.roomCode).toMatch(/^[A-Z2-9]{6}$/);
  });

  it("joins a player in guest mode", async () => {
    const createRes = await app.handle(
      new Request("http://localhost/quiz/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const created = (await createRes.json()) as { roomCode: string };

    const joinRes = await app.handle(
      new Request("http://localhost/quiz/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          roomCode: created.roomCode,
          displayName: "Guest Player",
        }),
      }),
    );
    expect(joinRes.status).toBe(200);
    const joined = (await joinRes.json()) as {
      ok: boolean;
      playerId: string;
      playerCount: number;
    };
    expect(joined.ok).toBe(true);
    expect(joined.playerCount).toBe(1);
    expect(joined.playerId).toMatch(/^p\d+$/);

    const resultsRes = await app.handle(
      new Request(`http://localhost/quiz/results/${created.roomCode}`),
    );
    expect(resultsRes.status).toBe(200);
    const results = (await resultsRes.json()) as {
      ranking: Array<{ userId: string | null }>;
    };

    expect(results.ranking[0]?.userId).toBeNull();
  });

  it("proxies animethemes media through the API", async () => {
    process.env.DATABASE_URL = "postgres://test";

    vi.spyOn(pool, "query").mockResolvedValue({
      rows: [{ webm_url: "https://v.animethemes.moe/demo-track.webm" }],
    } as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("demo-video", {
        status: 206,
        headers: {
          "content-type": "video/webm",
          "content-length": "10",
          "content-range": "bytes 0-9/10",
          "accept-ranges": "bytes",
          "cache-control": "public, max-age=60",
        },
      }),
    );

    const response = await app.handle(
      new Request("http://localhost/quiz/media/animethemes/demo-track", {
        headers: { range: "bytes=0-9" },
      }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("x-kwizik-media-proxy")).toBe("animethemes");
    expect(await response.text()).toBe("demo-video");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://v.animethemes.moe/demo-track.webm",
      expect.objectContaining({
        method: "GET",
      }),
    );
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get("range")).toBe("bytes=0-9");
    expect(headers.get("accept")).toBe("video/webm,*/*");
  });
});
