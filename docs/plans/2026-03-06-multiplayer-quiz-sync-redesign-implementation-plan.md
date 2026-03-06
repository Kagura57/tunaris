# Multiplayer Quiz Sync Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current poll-and-browser-readiness multiplayer flow with a server-timed round timeline, real-time room events, client-side scheduled playback, and shared AnimeThemes proxy caching so remote players start rounds together without slow inter-round waits.

**Architecture:** Keep the existing room snapshot HTTP endpoints as recovery/fallback paths, but move critical round orchestration onto a server-authoritative `plannedStartAtMs` timeline and a WebSocket room channel. Replace unanimous `mediaReady` gating with quorum-based `client_prepared` scheduling, then let late clients resync onto the canonical timeline. Remove browser-side next-track preload and replace it with a shared API-side AnimeThemes cache plus `N+1` warm-up.

**Tech Stack:** Bun, TypeScript, Elysia, React, TanStack Query, Zustand, Vitest

---

### Task 1: Introduce a dedicated round sync coordinator on the API

**Files:**
- Create: `apps/api/src/services/RoundSyncCoordinator.ts`
- Create: `apps/api/tests/round-sync-coordinator.spec.ts`

**Step 1: Write the failing test**

Create a focused coordinator unit test that locks quorum and timeout behavior without dragging `RoomStore` into the first change:

```ts
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
});
```

Add a second test in the same file for the timeout path:

```ts
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
```

**Step 2: Run test to verify it fails**

Run:

```bash
bun test apps/api/tests/round-sync-coordinator.spec.ts
```

Expected: FAIL because `RoundSyncCoordinator` does not exist yet.

**Step 3: Write minimal implementation**

Create `apps/api/src/services/RoundSyncCoordinator.ts` with a small state machine only for preparation and scheduling:

```ts
export type RoundSyncSnapshot = {
  status: "idle" | "preparing" | "scheduled" | "playing";
  phaseToken: string | null;
  plannedStartAtMs: number | null;
  maxWaitUntilMs: number | null;
  mediaOffsetSec: number;
  preparedCount: number;
  requiredPreparedCount: number;
  totalPlayerCount: number;
};

export class RoundSyncCoordinator {
  // keep internal state private and deterministic
}
```

Use a small helper for quorum:

```ts
function requiredPreparedCount(playerIds: string[], hostPlayerId: string | null) {
  if (playerIds.length <= 1) return 1;
  if (playerIds.length === 2) return 2;
  const majority = Math.floor(playerIds.length / 2) + 1;
  return hostPlayerId ? Math.max(2, majority) : majority;
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
bun test apps/api/tests/round-sync-coordinator.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/RoundSyncCoordinator.ts apps/api/tests/round-sync-coordinator.spec.ts
git commit -m "feat: add round sync coordinator"
```

### Task 2: Expose round sync metadata in room snapshots and shared client types

**Files:**
- Modify: `apps/api/src/services/RoomStore.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/stores/gameStore.ts`
- Modify: `apps/api/tests/room-store.spec.ts`
- Modify: `apps/web/src/routes/live-gameplay.spec.tsx`

**Step 1: Write the failing test**

Extend `apps/api/tests/room-store.spec.ts` with a snapshot contract test:

```ts
it("includes round sync metadata while a round is preparing", async () => {
  const store = new RoomStore();
  const created = store.createRoom();
  const host = store.joinRoom(created.roomCode, "Host");
  expect(host.status).toBe("ok");
  if (host.status !== "ok") return;

  store.setPlayerReady(created.roomCode, host.playerId, true);
  store.startGame(created.roomCode, host.playerId);

  const snapshot = store.roomState(created.roomCode);
  expect(snapshot?.roundSync).toEqual(
    expect.objectContaining({
      status: expect.stringMatching(/preparing|scheduled|playing/),
      phaseToken: expect.any(String),
      plannedStartAtMs: expect.any(Number),
      preparedCount: 0,
      requiredPreparedCount: 1,
    }),
  );
});
```

Extend the lightweight web store shape test in `apps/web/src/routes/live-gameplay.spec.tsx`:

```ts
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
```

**Step 2: Run test to verify it fails**

Run:

```bash
bun test apps/api/tests/room-store.spec.ts apps/web/src/routes/live-gameplay.spec.tsx
```

Expected: FAIL because `roundSync` is not serialized anywhere yet.

**Step 3: Write minimal implementation**

Add a nested `roundSync` contract to `RoomState` in `apps/web/src/lib/api.ts` and `LiveRoundState` in `apps/web/src/stores/gameStore.ts`:

```ts
roundSync: {
  status: "idle" | "preparing" | "scheduled" | "playing";
  phaseToken: string | null;
  plannedStartAtMs: number | null;
  maxWaitUntilMs: number | null;
  mediaOffsetSec: number;
  preparedCount: number;
  requiredPreparedCount: number;
  totalPlayerCount: number;
};
```

Wire `RoomStore.roomState()` to return a temporary `roundSync` snapshot, even if it is still mostly placeholder data in this task.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test apps/api/tests/room-store.spec.ts apps/web/src/routes/live-gameplay.spec.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/RoomStore.ts apps/web/src/lib/api.ts apps/web/src/stores/gameStore.ts apps/api/tests/room-store.spec.ts apps/web/src/routes/live-gameplay.spec.tsx
git commit -m "feat: expose round sync snapshot metadata"
```

### Task 3: Replace `mediaReady` gating with quorum-based `client_prepared`

**Files:**
- Modify: `apps/api/src/routes/quiz.ts`
- Modify: `apps/api/src/services/RoomStore.ts`
- Modify: `apps/api/tests/quiz-routes.spec.ts`
- Modify: `apps/api/tests/room-store.spec.ts`

**Step 1: Write the failing test**

Add route coverage for a new `POST /quiz/media/prepared` endpoint:

```ts
it("records client preparation without instantly starting the round", async () => {
  const createResponse = await app.handle(new Request("http://localhost/quiz/create", { method: "POST" }));
  const created = (await createResponse.json()) as { roomCode: string };

  const joinResponse = await app.handle(
    new Request("http://localhost/quiz/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomCode: created.roomCode, displayName: "Host" }),
    }),
  );
  const joined = (await joinResponse.json()) as { playerId: string };

  await app.handle(
    new Request("http://localhost/quiz/media/prepared", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roomCode: created.roomCode,
        playerId: joined.playerId,
        trackId: "demo-track",
      }),
    }),
  );

  const snapshotResponse = await app.handle(
    new Request(`http://localhost/realtime/room/${created.roomCode}`),
  );
  const payload = (await snapshotResponse.json()) as {
    snapshot: { state: string; roundSync: { preparedCount: number; plannedStartAtMs: number | null } };
  };

  expect(payload.snapshot.state).toBe("loading");
  expect(payload.snapshot.roundSync.preparedCount).toBe(1);
  expect(payload.snapshot.roundSync.plannedStartAtMs).not.toBeNull();
});
```

Add a server-side regression in `apps/api/tests/room-store.spec.ts`:

```ts
it("does not require unanimous preparation once quorum has been reached", () => {
  // build a 3-player room, prepare host + one player, tick short wait window, expect scheduled start
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
bun test apps/api/tests/quiz-routes.spec.ts apps/api/tests/room-store.spec.ts
```

Expected: FAIL because the new endpoint and scheduling semantics do not exist yet.

**Step 3: Write minimal implementation**

Add a shared handler in `apps/api/src/routes/quiz.ts`:

```ts
function handlePreparedMedia(body: unknown, set: { status?: number }) {
  const roomCode = readStringField(body, "roomCode");
  const playerId = readStringField(body, "playerId");
  const trackId = readStringField(body, "trackId");
  if (!roomCode || !playerId || !trackId) {
    set.status = 400;
    return { ok: false, error: "INVALID_PAYLOAD" };
  }
  return roomStore.reportMediaPrepared(roomCode, playerId, trackId);
}
```

Register both routes temporarily:

```ts
.post("/media/prepared", ({ body, set }) => handlePreparedMedia(body, set))
.post("/media/ready", ({ body, set }) => handlePreparedMedia(body, set))
```

Update `RoomStore` so preparation increments `preparedCount`, uses `RoundSyncCoordinator`, and schedules a shared `plannedStartAtMs` instead of moving the room to `playing` immediately.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test apps/api/tests/quiz-routes.spec.ts apps/api/tests/room-store.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/routes/quiz.ts apps/api/src/services/RoomStore.ts apps/api/tests/quiz-routes.spec.ts apps/api/tests/room-store.spec.ts
git commit -m "feat: schedule rounds from client prepared quorum"
```

### Task 4: Add API-side room event publishing and WebSocket transport

**Files:**
- Create: `apps/api/src/services/RoomRealtimeHub.ts`
- Modify: `apps/api/src/routes/realtime.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/services/RoomStore.ts`
- Create: `apps/api/tests/room-realtime-hub.spec.ts`
- Modify: `apps/api/tests/realtime-routes.spec.ts`

**Step 1: Write the failing test**

Create a hub unit test first:

```ts
import { describe, expect, it } from "vitest";
import { RoomRealtimeHub } from "../src/services/RoomRealtimeHub";

describe("RoomRealtimeHub", () => {
  it("broadcasts prepare and start events to room subscribers", () => {
    const hub = new RoomRealtimeHub();
    const received: string[] = [];

    const unsubscribe = hub.subscribe("ABCD12", (event) => {
      received.push(event.type);
    });

    hub.publish("ABCD12", { type: "prepare_round", roomCode: "ABCD12", serverNowMs: 1 });
    hub.publish("ABCD12", { type: "round_started", roomCode: "ABCD12", serverNowMs: 2 });

    unsubscribe();
    expect(received).toEqual(["prepare_round", "round_started"]);
  });
});
```

Keep `apps/api/tests/realtime-routes.spec.ts` covering the HTTP fallback endpoint and extend it with a simple contract assertion that the realtime router still mounts cleanly after the WebSocket route is added.

**Step 2: Run test to verify it fails**

Run:

```bash
bun test apps/api/tests/room-realtime-hub.spec.ts apps/api/tests/realtime-routes.spec.ts
```

Expected: FAIL because the hub does not exist yet.

**Step 3: Write minimal implementation**

Create `RoomRealtimeHub.ts` with a tiny room-scoped pub/sub:

```ts
export type RoomRealtimeEvent =
  | { type: "snapshot"; roomCode: string; serverNowMs: number; snapshot: unknown }
  | { type: "prepare_round"; roomCode: string; serverNowMs: number; phaseToken: string }
  | { type: "round_started"; roomCode: string; serverNowMs: number; phaseToken: string; startAtMs: number }
  | { type: "round_resync"; roomCode: string; serverNowMs: number; phaseToken: string; playbackPositionSec: number };
```

Extend `apps/api/src/routes/realtime.ts` with a WebSocket endpoint:

```ts
.ws("/room/:roomCode/ws", {
  open(ws) {
    // subscribe to room events and push JSON payloads
  },
  message(ws, raw) {
    // accept client ack packets later in the plan
  },
  close(ws) {
    // unsubscribe
  },
})
```

Keep the existing `GET /realtime/room/:roomCode` endpoint untouched as fallback.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test apps/api/tests/room-realtime-hub.spec.ts apps/api/tests/realtime-routes.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/RoomRealtimeHub.ts apps/api/src/routes/realtime.ts apps/api/src/index.ts apps/api/src/services/RoomStore.ts apps/api/tests/room-realtime-hub.spec.ts apps/api/tests/realtime-routes.spec.ts
git commit -m "feat: add realtime room event hub"
```

### Task 5: Add browser room socket support with HTTP snapshot fallback

**Files:**
- Create: `apps/web/src/lib/roomRealtimeSocket.ts`
- Modify: `apps/web/src/lib/realtime.ts`
- Create: `apps/web/src/lib/roomRealtimeSocket.spec.ts`

**Step 1: Write the failing test**

Create a focused socket helper test:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildRoomRealtimeUrl } from "./roomRealtimeSocket";

describe("room realtime socket", () => {
  it("derives a websocket URL from the resolved API base", () => {
    expect(buildRoomRealtimeUrl("https://api.kwizik.app", "ABCD12")).toBe(
      "wss://api.kwizik.app/realtime/room/ABCD12/ws",
    );
    expect(buildRoomRealtimeUrl("http://127.0.0.1:3001", "ABCD12")).toBe(
      "ws://127.0.0.1:3001/realtime/room/ABCD12/ws",
    );
  });
});
```

Add a second test that a closed socket triggers snapshot fallback through `fetchLiveRoomState`.

**Step 2: Run test to verify it fails**

Run:

```bash
bun test apps/web/src/lib/roomRealtimeSocket.spec.ts
```

Expected: FAIL because the helper file does not exist.

**Step 3: Write minimal implementation**

Create `apps/web/src/lib/roomRealtimeSocket.ts`:

```ts
export function buildRoomRealtimeUrl(apiBaseUrl: string, roomCode: string) {
  const url = new URL(`${apiBaseUrl.replace(/\/+$/, "")}/realtime/room/${roomCode}/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
```

Expose a small subscription helper that reconnects and falls back to `fetchLiveRoomState` on disconnect:

```ts
export function openRoomRealtimeSocket(...) {
  // wrap WebSocket lifecycle and typed JSON parsing here
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
bun test apps/web/src/lib/roomRealtimeSocket.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/lib/roomRealtimeSocket.ts apps/web/src/lib/realtime.ts apps/web/src/lib/roomRealtimeSocket.spec.ts
git commit -m "feat: add room websocket client helper"
```

### Task 6: Extract playback clock math for scheduled starts and resyncs

**Files:**
- Create: `apps/web/src/lib/roomPlaybackClock.ts`
- Create: `apps/web/src/lib/roomPlaybackClock.spec.ts`

**Step 1: Write the failing test**

Create deterministic helpers and tests:

```ts
import { describe, expect, it } from "vitest";
import {
  delayUntilStartMs,
  expectedPlaybackPositionSec,
  shouldResyncPlayback,
} from "./roomPlaybackClock";

describe("room playback clock", () => {
  it("computes the delay until the shared round start", () => {
    expect(delayUntilStartMs(10_000, 10_900)).toBe(900);
    expect(delayUntilStartMs(10_000, 9_900)).toBe(0);
  });

  it("computes expected playback position for late clients", () => {
    expect(expectedPlaybackPositionSec(12_500, 10_000, 5)).toBe(7.5);
  });

  it("flags resync only when drift exceeds tolerance", () => {
    expect(shouldResyncPlayback(7.8, 7.5, 0.4)).toBe(false);
    expect(shouldResyncPlayback(8.2, 7.5, 0.4)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
bun test apps/web/src/lib/roomPlaybackClock.spec.ts
```

Expected: FAIL because the helper file does not exist yet.

**Step 3: Write minimal implementation**

Create `apps/web/src/lib/roomPlaybackClock.ts`:

```ts
export function delayUntilStartMs(serverNowMs: number, plannedStartAtMs: number) {
  return Math.max(0, plannedStartAtMs - serverNowMs);
}

export function expectedPlaybackPositionSec(
  serverNowMs: number,
  startedAtMs: number,
  mediaOffsetSec: number,
) {
  return mediaOffsetSec + Math.max(0, serverNowMs - startedAtMs) / 1_000;
}

export function shouldResyncPlayback(currentTimeSec: number, expectedTimeSec: number, toleranceSec = 0.35) {
  return Math.abs(currentTimeSec - expectedTimeSec) > toleranceSec;
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
bun test apps/web/src/lib/roomPlaybackClock.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/lib/roomPlaybackClock.ts apps/web/src/lib/roomPlaybackClock.spec.ts
git commit -m "feat: add scheduled playback clock helpers"
```

### Task 7: Integrate scheduled playback and late resync on the player page

**Files:**
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/src/stores/gameStore.ts`
- Modify: `apps/web/src/routes/room-play-anime.spec.tsx`
- Modify: `apps/web/src/routes/live-gameplay.spec.tsx`

**Step 1: Write the failing test**

Extend the source-level player route test so it locks the new sync entry points:

```ts
it("schedules anime playback from roundSync instead of local readiness heuristics", () => {
  const file = readFileSync("apps/web/src/routes/room/$roomCode/play.tsx", "utf8");
  expect(file).toContain("roomRealtimeSocket");
  expect(file).toContain("roundSync?.plannedStartAtMs");
  expect(file).toContain("delayUntilStartMs");
  expect(file).toContain("expectedPlaybackPositionSec");
  expect(file).toContain("/quiz/media/prepared");
  expect(file).toContain("/quiz/media/started");
});
```

Update `apps/web/src/routes/live-gameplay.spec.tsx` to include the `roundSync` payload in the live round fixture if not already done in Task 2.

**Step 2: Run test to verify it fails**

Run:

```bash
bun test apps/web/src/routes/room-play-anime.spec.tsx apps/web/src/routes/live-gameplay.spec.tsx apps/web/src/lib/roomPlaybackClock.spec.ts apps/web/src/lib/roomRealtimeSocket.spec.ts
```

Expected: FAIL because `play.tsx` still reacts mainly to polling and local media readiness.

**Step 3: Write minimal implementation**

In `apps/web/src/routes/room/$roomCode/play.tsx`:

- subscribe to the room WebSocket;
- update local room state from pushed snapshots/events;
- send `POST /quiz/media/prepared` once the current track can be seeked and started;
- schedule local playback using `delayUntilStartMs(...)`;
- after `play()` succeeds, send `POST /quiz/media/started`;
- if the client is late, seek using `expectedPlaybackPositionSec(...)` and continue instead of blocking.

Use small constants near the top of the file:

```ts
const ROUND_START_RESYNC_TOLERANCE_SEC = 0.35;
const ROUND_SOCKET_SNAPSHOT_FALLBACK_MS = 10_000;
```

**Step 4: Run test to verify it passes**

Run:

```bash
bun test apps/web/src/routes/room-play-anime.spec.tsx apps/web/src/routes/live-gameplay.spec.tsx apps/web/src/lib/roomPlaybackClock.spec.ts apps/web/src/lib/roomRealtimeSocket.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/routes/room/$roomCode/play.tsx apps/web/src/stores/gameStore.ts apps/web/src/routes/room-play-anime.spec.tsx apps/web/src/routes/live-gameplay.spec.tsx
git commit -m "feat: schedule player playback from room timeline"
```

### Task 8: Integrate the same timeline on the projection page and retire critical 1s polling

**Files:**
- Modify: `apps/web/src/routes/room/$roomCode/view.tsx`
- Modify: `apps/web/src/lib/realtime.ts`
- Create: `apps/web/src/routes/room-view-sync.spec.tsx`

**Step 1: Write the failing test**

Create a structural route test for the projection page:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("room view sync", () => {
  it("uses websocket-driven round sync instead of critical 1s polling", () => {
    const file = readFileSync("apps/web/src/routes/room/$roomCode/view.tsx", "utf8");
    expect(file).toContain("roomRealtimeSocket");
    expect(file).toContain("roundSync?.plannedStartAtMs");
    expect(file).not.toContain("refetchInterval: 1_000");
  });
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
bun test apps/web/src/routes/room-view-sync.spec.tsx
```

Expected: FAIL because the projection page still uses critical `refetchInterval: 1_000`.

**Step 3: Write minimal implementation**

Mirror the player-side transport changes into `apps/web/src/routes/room/$roomCode/view.tsx`:

- subscribe to the same room WebSocket;
- keep HTTP snapshot fetching as reconnect/recovery logic only;
- replace critical `1_000ms` polling with a longer fallback interval such as `10_000ms`;
- schedule projection playback from `roundSync.plannedStartAtMs`.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test apps/web/src/routes/room-view-sync.spec.tsx apps/web/src/lib/roomRealtimeSocket.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/routes/room/$roomCode/view.tsx apps/web/src/lib/realtime.ts apps/web/src/routes/room-view-sync.spec.tsx
git commit -m "feat: switch projection sync to websocket timeline"
```

### Task 9: Add shared AnimeThemes proxy caching and `N+1` warm-up on the API

**Files:**
- Create: `apps/api/src/services/AnimeThemesProxyCache.ts`
- Create: `apps/api/tests/anime-themes-proxy-cache.spec.ts`
- Modify: `apps/api/src/routes/quiz.ts`
- Modify: `apps/api/src/services/RoomStore.ts`
- Modify: `apps/api/tests/quiz-routes.spec.ts`
- Modify: `apps/api/tests/room-store.spec.ts`

**Step 1: Write the failing test**

Create a single-flight cache test:

```ts
import { describe, expect, it, vi } from "vitest";
import { AnimeThemesProxyCache } from "../src/services/AnimeThemesProxyCache";

describe("AnimeThemesProxyCache", () => {
  it("deduplicates concurrent warm requests for the same video key", async () => {
    const fetcher = vi.fn(async () => new Response("demo", { status: 200 }));
    const cache = new AnimeThemesProxyCache({ fetcher });

    await Promise.all([
      cache.warm("Bleach-OP12.webm", "https://cdn.example.test/Bleach-OP12.webm"),
      cache.warm("Bleach-OP12.webm", "https://cdn.example.test/Bleach-OP12.webm"),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
```

Extend `apps/api/tests/quiz-routes.spec.ts` with a proxy-route assertion that repeated local requests hit the cache metadata path instead of issuing duplicate upstream fetches.

**Step 2: Run test to verify it fails**

Run:

```bash
bun test apps/api/tests/anime-themes-proxy-cache.spec.ts apps/api/tests/quiz-routes.spec.ts apps/api/tests/room-store.spec.ts
```

Expected: FAIL because the proxy currently streams directly from upstream.

**Step 3: Write minimal implementation**

Create `apps/api/src/services/AnimeThemesProxyCache.ts` with three small responsibilities:

```ts
export class AnimeThemesProxyCache {
  private inflight = new Map<string, Promise<void>>();
  private manifest = new Map<string, { filePath: string; etag: string | null; contentLength: number | null; warmedAtMs: number }>();

  async warm(videoKey: string, webmUrl: string) {
    // single-flight download into a temp file
  }

  async open(videoKey: string, webmUrl: string) {
    // ensure cached, then serve from local manifest
  }
}
```

Update `apps/api/src/routes/quiz.ts` so `/quiz/media/animethemes/:videoKey` serves via the cache service. Update `RoomStore` so when round `N` is scheduled, it warms round `N+1` if that track is AnimeThemes.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test apps/api/tests/anime-themes-proxy-cache.spec.ts apps/api/tests/quiz-routes.spec.ts apps/api/tests/room-store.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/AnimeThemesProxyCache.ts apps/api/tests/anime-themes-proxy-cache.spec.ts apps/api/src/routes/quiz.ts apps/api/src/services/RoomStore.ts apps/api/tests/quiz-routes.spec.ts apps/api/tests/room-store.spec.ts
git commit -m "feat: add shared animethemes proxy cache"
```

### Task 10: Remove deprecated sync code and run the final verification matrix

**Files:**
- Modify: `apps/api/src/routes/quiz.ts`
- Modify: `apps/api/src/services/RoomManager.ts`
- Modify: `apps/api/src/services/RoomStore.ts`
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/src/routes/room/$roomCode/view.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/stores/gameStore.ts`
- Modify: `progress.md`

**Step 1: Write the failing cleanup test**

Tighten the structural assertions so dead code removal is explicit:

```ts
expect(readFileSync("apps/web/src/routes/room/$roomCode/play.tsx", "utf8")).not.toContain("refetchInterval: 1_000");
expect(readFileSync("apps/web/src/routes/room/$roomCode/play.tsx", "utf8")).not.toContain("/quiz/media/ready");
expect(readFileSync("apps/api/src/services/RoomManager.ts", "utf8")).not.toContain("mediaReadyPlayerIds");
```

If a dedicated cleanup spec is clearer, create `apps/web/src/routes/room-sync-cleanup.spec.tsx`.

**Step 2: Run test to verify it fails**

Run:

```bash
bun test apps/api/tests/room-manager.spec.ts apps/web/src/routes/room-play-anime.spec.tsx apps/web/src/routes/room-view-sync.spec.tsx
```

Expected: FAIL because deprecated symbols still exist.

**Step 3: Write minimal implementation**

Remove obsolete code after the new flow is green:

- delete `mediaReadyPlayerIds` and related unanimous gating from `RoomManager`;
- remove the temporary `/quiz/media/ready` alias from `apps/api/src/routes/quiz.ts`;
- rename any remaining UI counters from `mediaReady*` to `prepared*` or remove them entirely if no longer needed;
- keep only long-interval snapshot fallback, not critical polling;
- update `progress.md` with the new multiplayer sync model and cache rollout.

**Step 4: Run the final verification matrix**

Run:

```bash
bun test apps/api/tests/round-sync-coordinator.spec.ts apps/api/tests/room-store.spec.ts apps/api/tests/quiz-routes.spec.ts apps/api/tests/realtime-routes.spec.ts apps/api/tests/room-realtime-hub.spec.ts apps/api/tests/anime-themes-proxy-cache.spec.ts
bun test apps/web/src/lib/roomRealtimeSocket.spec.ts apps/web/src/lib/roomPlaybackClock.spec.ts apps/web/src/routes/live-gameplay.spec.tsx apps/web/src/routes/room-play-anime.spec.tsx apps/web/src/routes/room-view-sync.spec.tsx
cd apps/web && bun run build
```

Expected: all tests PASS and the web build succeeds.

**Step 5: Commit**

```bash
git add apps/api/src/routes/quiz.ts apps/api/src/services/RoomManager.ts apps/api/src/services/RoomStore.ts apps/web/src/routes/room/$roomCode/play.tsx apps/web/src/routes/room/$roomCode/view.tsx apps/web/src/lib/api.ts apps/web/src/stores/gameStore.ts progress.md
git commit -m "refactor: remove legacy quiz sync flow"
```
