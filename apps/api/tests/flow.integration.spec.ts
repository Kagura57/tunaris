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
    expect(startRes.status).toBe(200);
    const started = (await startRes.json()) as { ok: boolean; state?: string };
    expect(started.ok).toBe(true);
    expect(started.state).toBe("countdown");
  });
});
