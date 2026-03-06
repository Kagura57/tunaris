import { Elysia } from "elysia";
import { roomStore } from "../services/RoomStore";

const ROOM_STREAM_INTERVAL_MS = 250;

type RoomSocketState = {
  intervalId: ReturnType<typeof setInterval>;
  lastPayload: string | null;
};

const roomSocketStates = new Map<string, RoomSocketState>();

function roomSocketKey(roomCode: string, socketId: string) {
  return `${roomCode}:${socketId}`;
}

function buildRoomSnapshotMessage(roomCode: string) {
  const snapshot = roomStore.roomState(roomCode);
  if (!snapshot) {
    return JSON.stringify({
      type: "room_missing" as const,
      roomCode,
      serverNowMs: Date.now(),
    });
  }

  return JSON.stringify({
    type: "snapshot" as const,
    ok: true as const,
    roomCode,
    snapshot,
    serverNowMs: Date.now(),
  });
}

function stopRoomSocket(roomCode: string, socketId: string) {
  const key = roomSocketKey(roomCode, socketId);
  const state = roomSocketStates.get(key);
  if (!state) return;
  clearInterval(state.intervalId);
  roomSocketStates.delete(key);
}

export const realtimeRoutes = new Elysia({ prefix: "/realtime" })
  .get("/room/:roomCode", ({ params, set }) => {
    const snapshot = roomStore.roomState(params.roomCode);
    if (!snapshot) {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }

    return {
      ok: true as const,
      roomCode: params.roomCode,
      snapshot,
      serverNowMs: Date.now(),
    };
  })
  .ws("/room/:roomCode/subscribe", {
    open(ws) {
      const roomCode = ws.data.params.roomCode;
      const socketId = ws.id;
      const key = roomSocketKey(roomCode, socketId);

      const pushSnapshot = () => {
        const payload = buildRoomSnapshotMessage(roomCode);
        const current = roomSocketStates.get(key);
        if (!current) return;
        if (current.lastPayload === payload) return;
        current.lastPayload = payload;
        ws.send(payload);

        try {
          const parsed = JSON.parse(payload) as { type?: string };
          if (parsed.type === "room_missing") {
            ws.close();
          }
        } catch {
          // Ignore malformed payload checks; ws.send already received the raw string.
        }
      };

      roomSocketStates.set(key, {
        intervalId: setInterval(pushSnapshot, ROOM_STREAM_INTERVAL_MS),
        lastPayload: null,
      });

      pushSnapshot();
    },
    close(ws) {
      stopRoomSocket(ws.data.params.roomCode, ws.id);
    },
  });
