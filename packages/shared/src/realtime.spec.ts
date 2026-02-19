import { describe, expect, it } from "vitest";
import { ROOM_PHASES, type RoomRealtimeEvent } from "./index";

describe("realtime contracts", () => {
  it("exposes live blindtest phases including leaderboard", () => {
    expect(ROOM_PHASES).toContain("leaderboard");
  });

  it("supports mixed answer mode payloads", () => {
    const event: RoomRealtimeEvent = {
      type: "round_started",
      roomCode: "ABCD12",
      round: 1,
      mode: "mcq",
      deadlineMs: 123,
      choices: ["A", "B", "C", "D"],
    };

    expect(event.type).toBe("round_started");
  });
});
