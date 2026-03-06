import { describe, expect, it } from "vitest";
import { RoundSyncCoordinator } from "../src/services/RoundSyncCoordinator";

describe("RoundSyncCoordinator", () => {
  it("schedules a shared start when host plus majority are prepared", () => {
    const sync = new RoundSyncCoordinator({
      startLeadMs: 900,
      maxWaitMs: 2_000,
    });

    sync.prepareRound({
      nowMs: 10_000,
      phaseToken: "phase-1",
      playerIds: ["p1", "p2", "p3"],
      hostPlayerId: "p1",
      mediaOffsetSec: 12,
    });

    sync.markPrepared("p1", 10_150);
    sync.markPrepared("p2", 10_250);

    const scheduled = sync.maybeScheduleStart(10_250);
    expect(scheduled).toEqual({
      type: "scheduled",
      startAtMs: 11_150,
      reason: "quorum",
    });
    expect(sync.snapshot()).toEqual(
      expect.objectContaining({
        status: "scheduled",
        phaseToken: "phase-1",
        preparedCount: 2,
        requiredPreparedCount: 2,
      }),
    );
  });

  it("forces a start after the short max wait even if one player is still missing", () => {
    const sync = new RoundSyncCoordinator({
      startLeadMs: 900,
      maxWaitMs: 2_000,
    });

    sync.prepareRound({
      nowMs: 20_000,
      phaseToken: "phase-2",
      playerIds: ["p1", "p2", "p3", "p4"],
      hostPlayerId: "p1",
      mediaOffsetSec: 0,
    });

    sync.markPrepared("p1", 20_100);
    sync.markPrepared("p2", 20_200);

    expect(sync.maybeScheduleStart(21_900)).toBeNull();
    expect(sync.maybeScheduleStart(22_000)).toEqual({
      type: "scheduled",
      startAtMs: 22_900,
      reason: "timeout",
    });
  });
});
