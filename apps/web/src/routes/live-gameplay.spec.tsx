import { describe, expect, it } from "vitest";
import { createGameStore } from "../stores/gameStore";

describe("live gameplay store", () => {
  it("stores current phase and answer mode", () => {
    const store = createGameStore();
    store.getState().setLiveRound({
      phase: "playing",
      mode: "mcq",
      round: 1,
      totalRounds: 10,
      deadlineMs: 123,
      previewUrl: null,
      media: null,
      choices: ["A", "B", "C", "D"],
      reveal: null,
      leaderboard: null,
    });
    expect(store.getState().liveRound?.phase).toBe("playing");
    expect(store.getState().liveRound?.mode).toBe("mcq");
  });
});
