import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("room snapshot", () => {
  it("returns room state for resync", async () => {
    const createRes = await app.handle(
      new Request("http://localhost/quiz/create", {
        method: "POST",
      }),
    );
    const created = (await createRes.json()) as { roomCode: string };

    const res = await app.handle(new Request(`http://localhost/room/${created.roomCode}/state`));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      roomCode: string;
      state: string;
      round: number;
      playerCount: number;
      poolSize: number;
      categoryQuery: string;
    };
    expect(payload.roomCode).toBe(created.roomCode);
    expect(payload.state).toBe("waiting");
    expect(payload.round).toBe(0);
    expect(payload.playerCount).toBe(0);
    expect(payload.poolSize).toBe(0);
    expect(payload.categoryQuery).toBe("anilist:linked:union");
  });
});
