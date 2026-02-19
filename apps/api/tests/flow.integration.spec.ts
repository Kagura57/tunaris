import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("core flow integration", () => {
  it("supports create -> join -> start with basic payload contracts", async () => {
    const createRes = await app.handle(
      new Request("http://localhost/quiz/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { roomCode: string };
    expect(typeof created.roomCode).toBe("string");
    expect(created.roomCode.length).toBeGreaterThanOrEqual(6);

    const joinRes = await app.handle(
      new Request("http://localhost/quiz/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomCode: created.roomCode, displayName: "Ben" }),
      }),
    );
    expect(joinRes.status).toBe(200);
    const joined = (await joinRes.json()) as { ok: boolean; playerId?: string };
    expect(joined.ok).toBe(true);
    expect(typeof joined.playerId).toBe("string");

    const startRes = await app.handle(
      new Request("http://localhost/quiz/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomCode: created.roomCode }),
      }),
    );
    if (startRes.status === 422) {
      const failed = (await startRes.json()) as { ok: false; error: string };
      expect(failed.ok).toBe(false);
      expect(failed.error).toBe("NO_TRACKS_FOUND");
      return;
    }

    expect(startRes.status).toBe(200);
    const started = (await startRes.json()) as {
      ok: boolean;
      state?: string;
      poolSize?: number;
      categoryQuery?: string;
    };
    expect(started.ok).toBe(true);
    expect(started.state).toBe("countdown");
    expect((started.poolSize ?? 0) > 0).toBe(true);
    expect(started.categoryQuery).toBe("popular hits");

    const snapshotRes = await app.handle(new Request(`http://localhost/room/${created.roomCode}/state`));
    expect(snapshotRes.status).toBe(200);
    const snapshot = (await snapshotRes.json()) as {
      state: string;
      playerCount: number;
      poolSize: number;
      categoryQuery: string;
    };
    expect(snapshot.state).toBe("countdown");
    expect(snapshot.playerCount).toBe(1);
    expect(snapshot.poolSize > 0).toBe(true);
    expect(snapshot.categoryQuery).toBe("popular hits");
  });
});
