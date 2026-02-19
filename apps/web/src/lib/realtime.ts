import { getRealtimeSnapshot, getRoomState, type RoomState } from "./api";
import { logClientEvent } from "./logger";

export async function fetchLiveRoomState(roomCode: string): Promise<RoomState> {
  try {
    const payload = await getRealtimeSnapshot(roomCode);
    return payload.snapshot;
  } catch (error) {
    logClientEvent("warn", "realtime_snapshot_fallback", {
      roomCode,
      reason: error instanceof Error ? error.message : "UNKNOWN_ERROR",
    });
    return getRoomState(roomCode);
  }
}
