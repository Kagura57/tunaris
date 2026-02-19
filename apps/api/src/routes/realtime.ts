import { Elysia } from "elysia";
import { roomStore } from "../services/RoomStore";

export const realtimeRoutes = new Elysia({ prefix: "/realtime" }).get(
  "/room/:roomCode",
  ({ params, set }) => {
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
  },
);
