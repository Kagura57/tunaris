import { afterEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/client";
import { app } from "../src/index";
import { animeThemesProxyCache } from "../src/services/AnimeThemesProxyCache";
import { roomStore } from "../src/services/RoomStore";
import type { MusicTrack } from "../src/services/music-types";

describe("quiz routes", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.DATABASE_URL;
    await animeThemesProxyCache.clear();
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
        status: 200,
        headers: {
          "content-type": "video/webm",
          "content-length": "10",
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

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://v.animethemes.moe/demo-track.webm",
      expect.objectContaining({
        method: "GET",
      }),
    );
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get("range")).toBeNull();
    expect(headers.get("accept")).toBe("video/webm,*/*");
  });

  it("serves repeated animethemes proxy requests from the shared cache", async () => {
    process.env.DATABASE_URL = "postgres://test";

    const querySpy = vi.spyOn(pool, "query").mockResolvedValue({
      rows: [{ webm_url: "https://v.animethemes.moe/demo-track.webm" }],
    } as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("shared-video", {
        status: 200,
        headers: {
          "content-type": "video/webm",
          "content-length": "12",
          "accept-ranges": "bytes",
          etag: "\"demo-etag\"",
        },
      }),
    );

    const first = await app.handle(
      new Request("http://localhost/quiz/media/animethemes/demo-track", {
        headers: { range: "bytes=0-5" },
      }),
    );
    expect(first.status).toBe(206);
    expect(first.headers.get("content-range")).toBe("bytes 0-5/12");

    const second = await app.handle(
      new Request("http://localhost/quiz/media/animethemes/demo-track", {
        headers: {
          range: "bytes=6-11",
          "if-range": "\"demo-etag\"",
        },
      }),
    );
    expect(second.status).toBe(206);
    expect(second.headers.get("content-range")).toBe("bytes 6-11/12");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it("records client preparation without instantly starting the round", async () => {
    const createResponse = await app.handle(new Request("http://localhost/quiz/create", { method: "POST" }));
    const created = (await createResponse.json()) as { roomCode: string };

    const joinResponse = await app.handle(
      new Request("http://localhost/quiz/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomCode: created.roomCode,
          displayName: "Host",
        }),
      }),
    );
    const joined = (await joinResponse.json()) as { playerId: string };

    const animeTrack: MusicTrack = {
      provider: "animethemes",
      id: "demo-track",
      title: "Demo Theme",
      artist: "OP1",
      previewUrl: "https://api.example.test/quiz/media/animethemes/demo-track.webm",
      sourceUrl: "https://api.example.test/quiz/media/animethemes/demo-track.webm",
      audioUrl: "https://api.example.test/quiz/media/animethemes/demo-track.webm",
      videoUrl: "https://api.example.test/quiz/media/animethemes/demo-track.webm",
    };

    const roomMap = (roomStore as unknown as { rooms: Map<string, unknown> }).rooms;
    const session = roomMap.get(created.roomCode) as {
      manager: {
        startGame: (input: { nowMs: number; countdownMs: number; totalRounds: number }) => boolean;
      };
      trackPool: MusicTrack[];
      totalRounds: number;
      roundModes: Array<"mcq" | "text">;
    } | null;
    expect(session).not.toBeNull();
    if (!session) return;

    session.trackPool = [animeTrack];
    session.totalRounds = 1;
    session.roundModes = ["text"];
    expect(session.manager.startGame({ nowMs: Date.now(), countdownMs: 0, totalRounds: 1 })).toBe(true);

    const preparedResponse = await app.handle(
      new Request("http://localhost/quiz/media/prepared", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomCode: created.roomCode,
          playerId: joined.playerId,
          trackId: animeTrack.id,
        }),
      }),
    );
    expect(preparedResponse.status).toBe(200);

    const snapshotResponse = await app.handle(
      new Request(`http://localhost/realtime/room/${created.roomCode}`),
    );
    const payload = (await snapshotResponse.json()) as {
      snapshot: {
        state: string;
        roundSync: {
          preparedCount: number;
          plannedStartAtMs: number | null;
        };
      };
    };

    expect(payload.snapshot.state).toBe("loading");
    expect(payload.snapshot.roundSync.preparedCount).toBe(1);
    expect(payload.snapshot.roundSync.plannedStartAtMs).not.toBeNull();
  });
});
