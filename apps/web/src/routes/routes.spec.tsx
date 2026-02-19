import { describe, expect, it } from "vitest";
import { createGameStore } from "../stores/gameStore";

describe("web store", () => {
  it("creates game store with live round state empty", () => {
    const store = createGameStore();
    expect(store.getState().isMuted).toBe(false);
    expect(store.getState().session.playerId).toBe(null);
    expect(store.getState().liveRound).toBe(null);
  });

  it("updates and clears gameplay session", () => {
    const store = createGameStore();
    store.getState().setSession({
      roomCode: "ROOM01",
      playerId: "p1",
      displayName: "Demo",
    });
    expect(store.getState().session.roomCode).toBe("ROOM01");
    expect(store.getState().session.playerId).toBe("p1");

    store.getState().clearSession();
    expect(store.getState().session.roomCode).toBe(null);
    expect(store.getState().session.playerId).toBe(null);
  });
});
