import { describe, expect, it } from "vitest";
import { RoomStore } from "../src/services/RoomStore";

describe("participants", () => {
  it("lets the creator join as regular participant", async () => {
    const store = new RoomStore();
    const { roomCode } = store.createRoom();
    const joined = store.joinRoom(roomCode, "HostPlayer");
    expect(joined.status).toBe("ok");
    if (joined.status !== "ok") return;
    expect(joined.value.ok).toBe(true);
    expect(joined.value.playerCount).toBe(1);
  });
});
