import { describe, expect, it } from "vitest";
import { createGameStore } from "../stores/gameStore";

describe("live gameplay store", () => {
  it("stores current phase and answer mode", () => {
    const store = createGameStore();
    store.getState().setLiveRound({
      phase: "playing",
      isLoadingMedia: false,
      mode: "mcq",
      round: 1,
      totalRounds: 10,
      deadlineMs: 123,
      roundSync: {
        status: "scheduled",
        phaseToken: "phase-1",
        plannedStartAtMs: 1_234,
        maxWaitUntilMs: 2_345,
        mediaOffsetSec: 12,
        preparedCount: 1,
        requiredPreparedCount: 2,
        totalPlayerCount: 3,
      },
      guessDoneCount: 1,
      guessTotalCount: 2,
      mediaReadyCount: 0,
      mediaReadyTotalCount: 2,
      revealSkipCount: 0,
      revealSkipTotalCount: 2,
      previewUrl: null,
      media: {
        provider: "animethemes",
        trackId: "demo-track",
        sourceUrl: "https://v.animethemes.moe/demo.webm",
        embedUrl: null,
      },
      nextMedia: null,
      choices: [
        { value: "A", titleRomaji: "A", titleEnglish: null, themeLabel: "OP1" },
        { value: "B", titleRomaji: "B", titleEnglish: null, themeLabel: "OP1" },
        { value: "C", titleRomaji: "C", titleEnglish: null, themeLabel: "OP1" },
        { value: "D", titleRomaji: "D", titleEnglish: null, themeLabel: "OP1" },
      ],
      reveal: null,
      leaderboard: null,
    });
    expect(store.getState().liveRound?.phase).toBe("playing");
    expect(store.getState().liveRound?.mode).toBe("mcq");
    expect(store.getState().liveRound?.media?.provider).toBe("animethemes");
    expect(store.getState().liveRound?.roundSync).toEqual({
      status: "scheduled",
      phaseToken: "phase-1",
      plannedStartAtMs: 1_234,
      maxWaitUntilMs: 2_345,
      mediaOffsetSec: 12,
      preparedCount: 1,
      requiredPreparedCount: 2,
      totalPlayerCount: 3,
    });
  });
});
