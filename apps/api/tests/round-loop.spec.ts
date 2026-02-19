import { describe, expect, it } from "vitest";
import { RoomManager } from "../src/services/RoomManager";

describe("round loop", () => {
  it("transitions through countdown -> playing -> reveal -> leaderboard", () => {
    const manager = new RoomManager("ROOM01");
    manager.startGame({ nowMs: 0, countdownMs: 3_000, totalRounds: 1 });

    manager.tick({ nowMs: 3_000, roundMs: 12_000, revealMs: 4_000, leaderboardMs: 2_000 });
    expect(manager.state()).toBe("playing");

    manager.tick({ nowMs: 15_000, roundMs: 12_000, revealMs: 4_000, leaderboardMs: 2_000 });
    expect(manager.state()).toBe("reveal");

    manager.tick({ nowMs: 19_000, roundMs: 12_000, revealMs: 4_000, leaderboardMs: 2_000 });
    expect(manager.state()).toBe("leaderboard");
  });
});
