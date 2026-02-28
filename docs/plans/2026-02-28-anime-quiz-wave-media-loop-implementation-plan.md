# Anime Quiz Wave Media Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver AMQ-style round flow with 20s guessing + 20s reveal, unanimous phase skip behavior, and a single wave-as-media container that hides/reveals continuous AnimeThemes video without restart.

**Architecture:** Keep server-authoritative timing in `RoomManager/RoomStore`, add phase action tracking (`answer/skip` during guessing, `next` votes during reveal), expose quorum metadata in room snapshot, and refactor web UI to one media shell with layered wave/video transitions. Preserve existing state names for compatibility (`leaderboard` kept but with zero duration).

**Tech Stack:** Bun, TypeScript, Elysia API, React + TanStack Query, Zustand, CSS modules in `styles.css`, Vitest.

---

### Task 1: Lock Round Durations to 20s/20s and Zero Leaderboard

**Files:**
- Modify: `apps/api/src/services/RoomStore.ts`
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/src/routes/room/$roomCode/view.tsx`
- Test: `apps/api/tests/round-loop.spec.ts`

**Step 1: Write the failing test**

```ts
it("uses 20s guessing and 20s reveal windows", () => {
  const manager = new RoomManager("ROOM01");
  manager.startGame({ nowMs: 0, countdownMs: 3_000, totalRounds: 1 });

  manager.tick({ nowMs: 3_000, roundMs: 20_000, revealMs: 20_000, leaderboardMs: 0 });
  expect(manager.state()).toBe("playing");

  manager.tick({ nowMs: 23_000, roundMs: 20_000, revealMs: 20_000, leaderboardMs: 0 });
  expect(manager.state()).toBe("reveal");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/round-loop.spec.ts -t "20s guessing"`  
Expected: FAIL before constants are updated.

**Step 3: Write minimal implementation**

```ts
const DEFAULT_ROUND_CONFIG = {
  countdownMs: 3_000,
  playingMs: 20_000,
  revealMs: 20_000,
  leaderboardMs: 0,
  baseScore: 1_000,
  maxRounds: 10,
} as const;
```

Update front progress constants:

```ts
const ROUND_MS = 20_000;
const REVEAL_MS = 20_000;
const LEADERBOARD_MS = 0;
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/round-loop.spec.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/RoomStore.ts apps/web/src/routes/room/$roomCode/play.tsx apps/web/src/routes/room/$roomCode/view.tsx apps/api/tests/round-loop.spec.ts
git commit -m "feat: switch anime round timings to 20s guess and 20s reveal"
```

---

### Task 2: Add Guess-Skip and Reveal-Next Vote Tracking in RoomManager

**Files:**
- Modify: `apps/api/src/services/RoomManager.ts`
- Test: `apps/api/tests/room-manager.spec.ts`

**Step 1: Write the failing test**

```ts
it("closes playing early when all active players are answered-or-skipped", () => {
  const room = new RoomManager("ABCD12");
  room.startGame({ nowMs: 0, countdownMs: 0, totalRounds: 1 });
  room.tick({ nowMs: 0, roundMs: 20_000, revealMs: 20_000, leaderboardMs: 0 });

  room.submitAnswer("p1", "answer", 1_000);
  room.skipGuessForPlayer("p2", 1_200);

  const tick = room.tick({ nowMs: 1_200, roundMs: 20_000, revealMs: 20_000, leaderboardMs: 0 });
  expect(tick.closedRounds).toHaveLength(1);
  expect(room.state()).toBe("reveal");
});

it("moves reveal early when all active players vote next", () => {
  const room = new RoomManager("ABCD12");
  room.forcePlayingRound(1, 20_000, 0);
  room.skipPlayingRound({ nowMs: 100, roundMs: 20_000 }); // enter reveal path in manager flow
  room.forceRevealStateForTest?.(100, 20_100); // or equivalent helper

  room.skipRevealForPlayer("p1", 200);
  room.skipRevealForPlayer("p2", 220);

  room.tick({ nowMs: 220, roundMs: 20_000, revealMs: 20_000, leaderboardMs: 0 });
  expect(["leaderboard", "playing", "results"]).toContain(room.state());
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/room-manager.spec.ts -t "answered-or-skipped"`  
Expected: FAIL with missing methods/behavior.

**Step 3: Write minimal implementation**

```ts
private guessedSkipPlayerIds = new Set<string>();
private revealSkipPlayerIds = new Set<string>();

skipGuessForPlayer(playerId: string, nowMs: number) {
  if (this.gameState !== "playing") return { accepted: false as const };
  if (this.answers.has(playerId)) return { accepted: false as const };
  if (this.roundDeadlineMs !== null && nowMs > this.roundDeadlineMs) return { accepted: false as const };
  this.guessedSkipPlayerIds.add(playerId);
  this.drafts.delete(playerId);
  return { accepted: true as const };
}

skipRevealForPlayer(playerId: string, nowMs: number) {
  if (this.gameState !== "reveal") return { accepted: false as const };
  if (this.roundDeadlineMs !== null && nowMs > this.roundDeadlineMs) return { accepted: false as const };
  this.revealSkipPlayerIds.add(playerId);
  return { accepted: true as const };
}
```

Add helpers used by `RoomStore` quorum checks:

```ts
hasGuessDone(playerId: string) {
  return this.answers.has(playerId) || this.guessedSkipPlayerIds.has(playerId);
}

hasRevealSkipped(playerId: string) {
  return this.revealSkipPlayerIds.has(playerId);
}
```

Clear sets on round transitions.

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/room-manager.spec.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/RoomManager.ts apps/api/tests/room-manager.spec.ts
git commit -m "feat: track guess and reveal skip votes in room manager"
```

---

### Task 3: Apply Unanimous Early Transition Rules in RoomStore

**Files:**
- Modify: `apps/api/src/services/RoomStore.ts`
- Test: `apps/api/tests/room-store.spec.ts`

**Step 1: Write the failing test**

```ts
it("jumps to reveal when all players are done before 20s", async () => {
  // create 2-player room, start game
  // player1 answers, player2 skips guess
  // roomState should become reveal immediately
});

it("jumps out of reveal when all players vote next", async () => {
  // reach reveal
  // both players call skip endpoint behavior
  // roomState should move to next phase immediately
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/room-store.spec.ts -t "all players are done"`  
Expected: FAIL with no early transition.

**Step 3: Write minimal implementation**

Add quorum evaluation helpers:

```ts
private activePlayerIds(session: RoomSession) {
  return this.sortedPlayers(session).map((p) => p.id);
}

private allGuessDone(session: RoomSession) {
  const ids = this.activePlayerIds(session);
  return ids.length > 0 && ids.every((id) => session.manager.hasGuessDone(id));
}

private allRevealSkipped(session: RoomSession) {
  const ids = this.activePlayerIds(session);
  return ids.length > 0 && ids.every((id) => session.manager.hasRevealSkipped(id));
}
```

In `submitAnswer` and skip handling, after accepted action:

```ts
if (session.manager.state() === "playing" && this.allGuessDone(session)) {
  this.progressSession(session, nowMs);
}
if (session.manager.state() === "reveal" && this.allRevealSkipped(session)) {
  this.progressSession(session, nowMs);
}
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/room-store.spec.ts -t "done before 20s"`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/RoomStore.ts apps/api/tests/room-store.spec.ts
git commit -m "feat: enforce unanimous early transitions for guessing and reveal"
```

---

### Task 4: Redefine `/quiz/skip` as Phase-Aware Player Vote

**Files:**
- Modify: `apps/api/src/services/RoomStore.ts`
- Modify: `apps/api/src/routes/quiz.ts`
- Modify: `apps/web/src/lib/api.ts`
- Test: `apps/api/tests/room-store.spec.ts`

**Step 1: Write the failing test**

```ts
it("accepts /skip during reveal as next-vote", async () => {
  // should not return INVALID_STATE while in reveal
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/room-store.spec.ts -t "skip during reveal"`  
Expected: FAIL (`INVALID_STATE`).

**Step 3: Write minimal implementation**

`RoomStore.skipCurrentRound`:

```ts
if (session.manager.state() === "playing") {
  return this.skipGuessPhase(session, playerId, nowMs);
}
if (session.manager.state() === "reveal") {
  return this.skipRevealPhase(session, playerId, nowMs);
}
return { status: "invalid_state" as const };
```

Remove host-only gate for skip; require player membership only.

Update route error mapping: drop `HOST_ONLY` branch for skip.

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/room-store.spec.ts -t "skip during reveal"`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/RoomStore.ts apps/api/src/routes/quiz.ts apps/web/src/lib/api.ts apps/api/tests/room-store.spec.ts
git commit -m "feat: make skip endpoint phase-aware and player-vote based"
```

---

### Task 5: Expose Quorum Counters in Room Snapshot and Store Types

**Files:**
- Modify: `apps/api/src/services/RoomStore.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/stores/gameStore.ts`
- Test: `apps/web/src/routes/live-gameplay.spec.tsx`

**Step 1: Write the failing test**

```ts
it("stores skip quorum metadata in live round state", () => {
  const store = createGameStore();
  store.getState().setLiveRound({
    // existing fields...
    guessDoneCount: 1,
    guessTotalCount: 2,
    revealSkipCount: 0,
    revealSkipTotalCount: 2,
  });
  expect(store.getState().liveRound?.guessDoneCount).toBe(1);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/routes/live-gameplay.spec.tsx`  
Expected: FAIL type mismatch.

**Step 3: Write minimal implementation**

Add fields to room snapshot payload and frontend types:

```ts
guessDoneCount: number;
guessTotalCount: number;
revealSkipCount: number;
revealSkipTotalCount: number;
```

Thread fields into `setLiveRound` mapping in `play.tsx`.

**Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/routes/live-gameplay.spec.tsx`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/RoomStore.ts apps/web/src/lib/api.ts apps/web/src/stores/gameStore.ts apps/web/src/routes/live-gameplay.spec.tsx apps/web/src/routes/room/$roomCode/play.tsx
git commit -m "feat: expose and store per-phase quorum counters"
```

---

### Task 6: Merge Wave Bar and AnimeThemes Video into One Media Shell (Player View)

**Files:**
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/routes/room-play-anime.spec.tsx`

**Step 1: Write the failing test**

```ts
it("renders a single media shell with wave and anime video layers", () => {
  const file = readFileSync("apps/web/src/routes/room/$roomCode/play.tsx", "utf8");
  expect(file).toContain("media-shell");
  expect(file).not.toContain("blindtest-video-shell");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/routes/room-play-anime.spec.tsx`  
Expected: FAIL.

**Step 3: Write minimal implementation**

New JSX structure (single container):

```tsx
<div className={`media-shell ${state?.state === "reveal" ? "is-reveal" : "is-playing"}`}>
  <video ref={animeVideoRef} className="media-video-layer" ... />
  <div className="media-wave-layer" aria-hidden="true">...</div>
  <div className="media-timeline-layer">...</div>
</div>
```

Remove separate offscreen anime video shell block.

**Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/routes/room-play-anime.spec.tsx`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/routes/room/$roomCode/play.tsx apps/web/src/styles.css apps/web/src/routes/room-play-anime.spec.tsx
git commit -m "feat: merge wave and anime video into unified media shell"
```

---

### Task 7: Add Guess Skip and Reveal Next Controls with Quorum UX

**Files:**
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/routes/routes.spec.tsx`

**Step 1: Write the failing test**

```ts
it("shows skip in playing and next in reveal", () => {
  const file = readFileSync("apps/web/src/routes/room/$roomCode/play.tsx", "utf8");
  expect(file).toContain("Skip");
  expect(file).toContain("Next");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/routes/routes.spec.tsx -t "skip in playing"`  
Expected: FAIL before controls exist.

**Step 3: Write minimal implementation**

- Render `Skip` button when `state.state === "playing"`.
- Render `Next` button when `state.state === "reveal"`.
- Both call `skipMutation.mutate()`.
- Disable button after local accepted vote.
- Show quorum text from snapshot counters.

Example:

```tsx
<p className="status">Skip: {state.guessDoneCount}/{state.guessTotalCount}</p>
<button onClick={() => skipMutation.mutate()} disabled={guessSkipLocked}>Skip</button>
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/routes/routes.spec.tsx`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/routes/room/$roomCode/play.tsx apps/web/src/styles.css apps/web/src/routes/routes.spec.tsx
git commit -m "feat: add phase-specific skip controls with quorum feedback"
```

---

### Task 8: Mirror Unified Media Shell in Projection View

**Files:**
- Modify: `apps/web/src/routes/room/$roomCode/view.tsx`
- Modify: `apps/web/src/styles.css`

**Step 1: Write the failing test**

```ts
it("projection uses same media-shell layering", () => {
  const file = readFileSync("apps/web/src/routes/room/$roomCode/view.tsx", "utf8");
  expect(file).toContain("media-shell");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/routes/routes.spec.tsx -t "projection uses"`  
Expected: FAIL or missing assertion context.

**Step 3: Write minimal implementation**

Apply same structure as player view:

```tsx
<div className={`media-shell large ${revealVideoActive ? "is-reveal" : "is-playing"}`}>...</div>
```

Keep projection-specific wave density but same reveal transition model.

**Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/routes/routes.spec.tsx`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/routes/room/$roomCode/view.tsx apps/web/src/styles.css apps/web/src/routes/routes.spec.tsx
git commit -m "feat: align projection media shell with player wave-video model"
```

---

### Task 9: End-to-End Validation and Cleanup

**Files:**
- Modify: `apps/api/tests/round-loop.spec.ts`
- Modify: `apps/api/tests/room-manager.spec.ts`
- Modify: `apps/api/tests/room-store.spec.ts`
- Optional: `apps/web/e2e/live-blindtest.spec.ts`

**Step 1: Add final regression tests**

Add explicit cases:

- Guess unanimous done before timeout.
- Reveal unanimous next before timeout.
- Skip in reveal on final round lands in results.
- Snapshot counters are coherent.

**Step 2: Run full targeted suite**

Run:

```bash
bun test apps/api/tests/round-loop.spec.ts apps/api/tests/room-manager.spec.ts apps/api/tests/room-store.spec.ts apps/web/src/routes/live-gameplay.spec.tsx apps/web/src/routes/routes.spec.tsx
```

Expected: PASS.

**Step 3: Optional UI smoke e2e**

Run: `bun run test:e2e -- --grep "live blindtest"`  
Expected: PASS or known unrelated flakes documented.

**Step 4: Commit final test updates**

```bash
git add apps/api/tests/round-loop.spec.ts apps/api/tests/room-manager.spec.ts apps/api/tests/room-store.spec.ts apps/web/src/routes/live-gameplay.spec.tsx apps/web/src/routes/routes.spec.tsx apps/web/e2e/live-blindtest.spec.ts
git commit -m "test: cover unanimous skip flow and unified media shell"
```

---

## Execution Notes

- Keep YAGNI scope: do not rename public states (`playing/reveal/leaderboard`) in this iteration.
- Keep skip endpoint path unchanged (`/quiz/skip`) to avoid API churn.
- Ensure UX copy no longer references host-only skip behavior.
- If `leaderboardMs=0` triggers edge race in UI progress, clamp denominator and fall back to immediate completion for that phase.

## Skills Reference

- Planning workflow: `@writing-plans`
- Execution workflow (next step): `superpowers:executing-plans`
