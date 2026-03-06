import type { RoomState } from "./api";

export function getEffectiveRoomPhase(
  state: Pick<RoomState, "state" | "roundSync"> | null | undefined,
  clockNowMs: number,
) {
  if (!state) return null;
  if (
    state.state === "loading" &&
    typeof state.roundSync?.plannedStartAtMs === "number" &&
    clockNowMs >= state.roundSync.plannedStartAtMs
  ) {
    return "playing" as const;
  }
  return state.state;
}

export function getEffectiveRoomDeadlineMs(
  state: Pick<RoomState, "state" | "deadlineMs" | "roundSync"> | null | undefined,
  clockNowMs: number,
  roundMs: number,
) {
  if (!state) return null;
  if (
    state.state === "loading" &&
    typeof state.roundSync?.plannedStartAtMs === "number" &&
    clockNowMs >= state.roundSync.plannedStartAtMs
  ) {
    return state.roundSync.plannedStartAtMs + Math.max(0, roundMs);
  }
  return state.deadlineMs;
}

export function getEffectiveRoomStartedAtMs(
  state: Pick<RoomState, "state" | "deadlineMs" | "roundSync"> | null | undefined,
  clockNowMs: number,
  roundMs: number,
) {
  if (!state) return null;
  const phase = getEffectiveRoomPhase(state, clockNowMs);
  if (phase !== "playing") return null;

  if (
    state.state === "loading" &&
    typeof state.roundSync?.plannedStartAtMs === "number" &&
    clockNowMs >= state.roundSync.plannedStartAtMs
  ) {
    return state.roundSync.plannedStartAtMs;
  }

  if (typeof state.deadlineMs === "number") {
    return state.deadlineMs - Math.max(0, roundMs);
  }

  return null;
}

export function getEffectiveRoomElapsedMs(
  state: Pick<RoomState, "state" | "deadlineMs" | "roundSync"> | null | undefined,
  clockNowMs: number,
  roundMs: number,
) {
  const startedAtMs = getEffectiveRoomStartedAtMs(state, clockNowMs, roundMs);
  if (startedAtMs === null) return null;
  return Math.max(0, clockNowMs - startedAtMs);
}

export function getNextRoomTransitionAtMs(
  state: Pick<RoomState, "state" | "deadlineMs" | "roundSync"> | null | undefined,
) {
  if (!state) return null;
  if (
    state.state === "loading" &&
    typeof state.roundSync?.plannedStartAtMs === "number"
  ) {
    return state.roundSync.plannedStartAtMs;
  }
  return state.deadlineMs;
}
