import { describe, expect, it } from "vitest";
import {
  getEffectiveRoomDeadlineMs,
  getEffectiveRoomElapsedMs,
  getEffectiveRoomPhase,
  getEffectiveRoomStartedAtMs,
  getNextRoomTransitionAtMs,
} from "./liveRoundTiming";

describe("live round timing", () => {
  it("treats a scheduled loading round as locally playing once startAt is reached", () => {
    const state = {
      state: "loading" as const,
      deadlineMs: null,
      roundSync: {
        plannedStartAtMs: 1_500,
      },
    };

    expect(getEffectiveRoomPhase(state, 1_499)).toBe("loading");
    expect(getEffectiveRoomPhase(state, 1_500)).toBe("playing");
    expect(getEffectiveRoomDeadlineMs(state, 1_500, 20_000)).toBe(21_500);
    expect(getEffectiveRoomStartedAtMs(state, 1_500, 20_000)).toBe(1_500);
    expect(getEffectiveRoomElapsedMs(state, 1_750, 20_000)).toBe(250);
    expect(getNextRoomTransitionAtMs(state)).toBe(1_500);
  });

  it("keeps server deadlines when the round is already past loading", () => {
    const state = {
      state: "playing" as const,
      deadlineMs: 9_999,
      roundSync: {
        plannedStartAtMs: 1_500,
      },
    };

    expect(getEffectiveRoomPhase(state, 2_000)).toBe("playing");
    expect(getEffectiveRoomDeadlineMs(state, 2_000, 20_000)).toBe(9_999);
    expect(getEffectiveRoomStartedAtMs(state, 2_000, 20_000)).toBe(-10_001);
    expect(getNextRoomTransitionAtMs(state)).toBe(9_999);
  });
});
