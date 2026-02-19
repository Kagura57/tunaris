import { describe, expect, it } from "vitest";
import { buildMatchInsertPayload } from "../src/repositories/MatchRepository";

describe("match repository", () => {
  it("maps room result payload to persistent record", () => {
    const payload = buildMatchInsertPayload({
      roomCode: "ROOM42",
      categoryQuery: "pop",
      ranking: [],
    });

    expect(payload.roomCode).toBe("ROOM42");
    expect(payload.config.categoryQuery).toBe("pop");
    expect(payload.config.rankingSize).toBe(0);
  });
});
