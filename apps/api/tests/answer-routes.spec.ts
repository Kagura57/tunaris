import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("answer routes", () => {
  it("returns 404 when room does not exist", async () => {
    const response = await app.handle(
      new Request("http://localhost/quiz/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomCode: "ZZZZZZ",
          playerId: "p1",
          answer: "song",
        }),
      }),
    );

    expect(response.status).toBe(404);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("ROOM_NOT_FOUND");
  });

  it("returns 404 when player does not exist in room", async () => {
    const createRes = await app.handle(
      new Request("http://localhost/quiz/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const created = (await createRes.json()) as { roomCode: string };

    const response = await app.handle(
      new Request("http://localhost/quiz/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomCode: created.roomCode,
          playerId: "p999",
          answer: "song",
        }),
      }),
    );

    expect(response.status).toBe(404);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("PLAYER_NOT_FOUND");
  });

  it("rejects answers while room is still in countdown", async () => {
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomCode: created.roomCode, displayName: "Ben" }),
      }),
    );
    const joined = (await joinRes.json()) as { playerId: string };

    await app.handle(
      new Request("http://localhost/quiz/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomCode: created.roomCode }),
      }),
    );

    const answerRes = await app.handle(
      new Request("http://localhost/quiz/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomCode: created.roomCode,
          playerId: joined.playerId,
          answer: "song",
        }),
      }),
    );

    expect(answerRes.status).toBe(200);
    const payload = (await answerRes.json()) as { accepted: boolean };
    expect(payload.accepted).toBe(false);
  });
});
