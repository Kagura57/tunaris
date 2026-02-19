import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("quiz routes", () => {
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
});
