import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("realtime route contract", () => {
  it("exposes realtime room endpoint", async () => {
    const createResponse = await app.handle(
      new Request("http://localhost/quiz/create", {
        method: "POST",
      }),
    );
    const created = (await createResponse.json()) as { roomCode: string };

    const response = await app.handle(
      new Request(`http://localhost/realtime/room/${created.roomCode}`),
    );
    expect(response.status).toBe(200);
  });
});
