import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RealtimeRoomSnapshot } from "./api";
import { logClientEvent } from "./logger";

const ENV_API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() ?? "";
const SOCKET_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000];

type RoomRealtimeMessage =
  | ({
      type: "snapshot";
    } & RealtimeRoomSnapshot)
  | {
      type: "room_missing";
      roomCode: string;
      serverNowMs: number;
    };

function toSocketBaseUrl(raw: string) {
  const normalized = raw.trim().replace(/\/+$/, "");
  if (normalized.startsWith("https://")) {
    return `wss://${normalized.slice("https://".length)}`;
  }
  if (normalized.startsWith("http://")) {
    return `ws://${normalized.slice("http://".length)}`;
  }
  return normalized;
}

function roomSocketCandidates() {
  const candidates: string[] = [];

  if (ENV_API_BASE_URL.length > 0) {
    candidates.push(toSocketBaseUrl(ENV_API_BASE_URL));
  }

  candidates.push("ws://127.0.0.1:3001");
  candidates.push("ws://localhost:3001");

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of candidates) {
    const normalized = value.trim().replace(/\/+$/, "");
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function parseRealtimeMessage(raw: unknown): RoomRealtimeMessage | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as RoomRealtimeMessage;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.type === "snapshot") return parsed;
    if (parsed.type === "room_missing") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function useRoomRealtimeSubscription(roomCode: string) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!roomCode) return;

    const candidates = roomSocketCandidates().map(
      (baseUrl) => `${baseUrl}/realtime/room/${encodeURIComponent(roomCode)}/subscribe`,
    );

    let closed = false;
    let retryTimer: number | null = null;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let candidateIndex = 0;

    const cleanupRetryTimer = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const connect = () => {
      if (closed) return;

      const url = candidates[candidateIndex] ?? candidates[0];
      if (!url) return;

      socket = new WebSocket(url);

      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
      };

      socket.onmessage = (event) => {
        const message = parseRealtimeMessage(event.data);
        if (!message) return;

        if (message.type === "snapshot") {
          queryClient.setQueryData(["realtime-room", roomCode], message);
          queryClient.setQueryData(["realtime-room-view", roomCode], message);
          return;
        }

        queryClient.invalidateQueries({ queryKey: ["realtime-room", roomCode] }).catch(() => undefined);
        queryClient.invalidateQueries({ queryKey: ["realtime-room-view", roomCode] }).catch(() => undefined);
      };

      socket.onerror = () => {
        socket?.close();
      };

      socket.onclose = () => {
        setConnected(false);
        if (closed) return;

        const delayMs =
          SOCKET_RETRY_DELAYS_MS[Math.min(attempt, SOCKET_RETRY_DELAYS_MS.length - 1)] ??
          SOCKET_RETRY_DELAYS_MS[SOCKET_RETRY_DELAYS_MS.length - 1] ??
          4_000;
        const currentAttempt = attempt;
        attempt += 1;
        candidateIndex = (candidateIndex + 1) % candidates.length;

        logClientEvent("warn", "room_realtime_socket_disconnected", {
          roomCode,
          attempt: currentAttempt + 1,
          delayMs,
        });

        cleanupRetryTimer();
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          connect();
        }, delayMs);
      };
    };

    connect();

    return () => {
      closed = true;
      setConnected(false);
      cleanupRetryTimer();
      socket?.close();
    };
  }, [queryClient, roomCode]);

  return connected;
}
