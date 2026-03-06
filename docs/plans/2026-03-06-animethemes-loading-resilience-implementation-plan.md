# AnimeThemes Loading Resilience Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make AnimeThemes rounds wait much longer before auto-skipping, keep frontend/backend timeout behavior aligned, and preload exactly one next AnimeThemes round on the player page to reduce transition buffering.

**Architecture:** Introduce a shared "extreme failure only" timeout policy for AnimeThemes playback, keep transient buffering as non-fatal, and mirror the existing projection-side next-track preload flow on the player page. The API remains the final authority for skipping after an explicit `media/unavailable` report, but both frontend and backend stop treating short stalls as terminal.

**Tech Stack:** Bun, TypeScript, React, TanStack Query, Vitest, Elysia

---

### Task 1: Lock the new backend timeout policy in tests

**Files:**
- Modify: `apps/api/tests/room-store.spec.ts`

**Step 1: Write the failing test**

Add or replace the short-timeout AnimeThemes loading timeout coverage with two explicit expectations:

```ts
it("keeps animethemes rounds loading until an extreme timeout is reached", async () => {
  let nowMs = 0;
  const animeTrack: MusicTrack = {
    provider: "animethemes",
    id: "timeout-track",
    title: "Timeout Anime",
    artist: "OP1",
    previewUrl: "https://api.example.test/quiz/media/animethemes/timeout-track.webm",
    sourceUrl: "https://api.example.test/quiz/media/animethemes/timeout-track.webm",
    audioUrl: "https://api.example.test/quiz/media/animethemes/timeout-track.webm",
    videoUrl: "https://api.example.test/quiz/media/animethemes/timeout-track.webm",
  };

  const store = new RoomStore({
    now: () => nowMs,
    getTrackPool: async () => [animeTrack],
    config: {
      countdownMs: 10,
      loadingMs: 100,
      loadingTimeoutMs: 90_000,
      playingMs: 200,
      revealMs: 10,
      leaderboardMs: 0,
      maxRounds: 1,
    },
  });

  const created = store.createRoom();
  const host = store.joinRoom(created.roomCode, "Host");
  expect(host.status).toBe("ok");
  if (host.status !== "ok") return;

  const roomMap = (store as unknown as { rooms: Map<string, unknown> }).rooms;
  const session = roomMap.get(created.roomCode) as {
    manager: {
      startGame: (input: { nowMs: number; countdownMs: number; totalRounds: number }) => boolean;
    };
    trackPool: MusicTrack[];
    totalRounds: number;
    roundModes: Array<"mcq" | "text">;
  } | null;
  expect(session).not.toBeNull();
  if (!session) return;

  session.trackPool = [animeTrack];
  session.totalRounds = 1;
  session.roundModes = ["text"];
  expect(session.manager.startGame({ nowMs: 0, countdownMs: 10, totalRounds: 1 })).toBe(true);

  nowMs = 10;
  expect(store.roomState(created.roomCode)?.state).toBe("loading");

  nowMs = 30_000;
  expect(store.roomState(created.roomCode)?.state).toBe("loading");

  nowMs = 90_100;
  expect(store.roomState(created.roomCode)?.state).toBe("results");
});
```

Keep the existing explicit `reportMediaUnavailable()` acceptance test intact.

**Step 2: Run test to verify it fails**

Run:

```bash
bun test apps/api/tests/room-store.spec.ts
```

Expected: FAIL because the room still auto-skips at the old short backend timeout.

**Step 3: Write minimal implementation**

Do not change implementation yet. This task is test-first only.

**Step 4: Run test to verify the failure is stable**

Run:

```bash
bun test apps/api/tests/room-store.spec.ts
```

Expected: the same timeout-policy test still fails for the same reason.

**Step 5: Commit**

```bash
git add apps/api/tests/room-store.spec.ts
git commit -m "test: cover extreme animethemes loading timeout"
```

### Task 2: Align backend AnimeThemes timeout behavior with the extreme-only policy

**Files:**
- Modify: `apps/api/src/services/RoomStore.ts`
- Test: `apps/api/tests/room-store.spec.ts`

**Step 1: Write the failing implementation target**

Introduce a dedicated constant near `DEFAULT_ROUND_CONFIG`:

```ts
const ANIMETHEMES_EXTREME_TIMEOUT_MS = 90_000;
```

Update the AnimeThemes loading timeout resolution to use the max of configured values and this floor:

```ts
private loadingTimeoutMsForCurrentRound(session: RoomSession) {
  const configured = Math.max(this.config.loadingMs, this.config.loadingTimeoutMs);
  const round = session.manager.round();
  if (round <= 0) return 0;
  const track = this.trackForRound(session, round);
  if (!track || track.provider !== "animethemes") return 0;
  return Math.max(configured, ANIMETHEMES_EXTREME_TIMEOUT_MS);
}
```

**Step 2: Run test to verify it now passes**

Run:

```bash
bun test apps/api/tests/room-store.spec.ts
```

Expected: PASS for the new timeout coverage and the existing `reportMediaUnavailable()` test.

**Step 3: Check for regressions in route-level AnimeThemes behavior**

Run:

```bash
bun test apps/api/tests/quiz-routes.spec.ts
```

Expected: PASS, with the AnimeThemes proxy route still behaving exactly as before.

**Step 4: Write minimal cleanup if needed**

If any log message or helper name still implies a short timeout assumption, rename only what is necessary to keep the code readable. Do not add caching or new background jobs in this change.

**Step 5: Commit**

```bash
git add apps/api/src/services/RoomStore.ts apps/api/tests/room-store.spec.ts apps/api/tests/quiz-routes.spec.ts
git commit -m "fix: only skip animethemes rounds after extreme timeout"
```

### Task 3: Lock the new frontend no-false-positive behavior in tests

**Files:**
- Modify: `apps/web/src/routes/room-play-anime.spec.tsx`
- Modify: `apps/web/src/routes/live-gameplay.spec.tsx`

**Step 1: Write the failing test**

Extend the lightweight route-level source test to assert the new player-page preload and long-load policy markers exist:

```ts
it("keeps anime playback tolerant and preloads the next animethemes track on the player page", () => {
  const file = readFileSync("apps/web/src/routes/room/$roomCode/play.tsx", "utf8");
  expect(file).toContain("ANIME_MEDIA_EXTREME_TIMEOUT_MS");
  expect(file).toContain("ANIME_MEDIA_LONG_LOAD_TOAST_MS");
  expect(file).toContain("state?.nextMedia?.provider === \"animethemes\"");
  expect(file).toContain("data-kwizik-next-anime-preload");
  expect(file).not.toContain("ANIME_MEDIA_ERROR_THRESHOLD = 3");
});
```

Keep `live-gameplay.spec.tsx` unchanged unless typing updates require a fixture tweak.

**Step 2: Run test to verify it fails**

Run:

```bash
bun test apps/web/src/routes/room-play-anime.spec.tsx apps/web/src/routes/live-gameplay.spec.tsx
```

Expected: FAIL because `play.tsx` still uses the old short-threshold failure path and does not preload `nextMedia`.

**Step 3: Write minimal implementation target**

Do not edit `play.tsx` yet. This task is test-first only.

**Step 4: Run test to verify the failure is stable**

Run:

```bash
bun test apps/web/src/routes/room-play-anime.spec.tsx apps/web/src/routes/live-gameplay.spec.tsx
```

Expected: the same test still fails for the same missing markers.

**Step 5: Commit**

```bash
git add apps/web/src/routes/room-play-anime.spec.tsx apps/web/src/routes/live-gameplay.spec.tsx
git commit -m "test: cover player-side animethemes preload policy"
```

### Task 4: Make the player page wait longer and preload one AnimeThemes round ahead

**Files:**
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/src/routes/room-play-anime.spec.tsx`
- Modify: `apps/web/src/routes/live-gameplay.spec.tsx`

**Step 1: Replace the aggressive AnimeThemes failure heuristics**

Remove the short-threshold counter:

```ts
const ANIME_MEDIA_ERROR_THRESHOLD = 3;
```

Replace it with explicit long-load constants:

```ts
const ANIME_MEDIA_LONG_LOAD_TOAST_MS = 20_000;
const ANIME_MEDIA_EXTREME_TIMEOUT_MS = 90_000;
```

Add refs to dedupe toasts and progress tracking:

```ts
const animeLongLoadToastRef = useRef<string | null>(null);
const animeLastProgressAtRef = useRef<number | null>(null);
```

Refresh `animeLastProgressAtRef` from non-terminal video lifecycle signals such as:

```ts
function markAnimeProgress() {
  animeLastProgressAtRef.current = Date.now();
}
```

Call it from:

- `handleAnimeLoadedMetadata()`
- `handleAnimeLoadedData()`
- `handleAnimeCanPlay()`
- `handleAnimePlaying()`
- a `progress` listener effect on `animeVideoRef.current`

**Step 2: Only report unavailable after the extreme timeout**

Change `handleAnimeMediaUnavailable()` so it becomes the terminal path only. It must no longer count transient errors before escalating.

Keep the API report path, but call it only from an effect like:

```ts
useEffect(() => {
  if (!session.playerId) return;
  if (state?.state !== "loading") return;
  if (!state.media || state.media.provider !== "animethemes") return;
  if (!usingAnimeVideoPlayback) return;
  if (animePlaybackStatus === "ready" || animePlaybackStatus === "playing") return;

  const startedAt = animeLastProgressAtRef.current ?? Date.now();

  const longToastId = window.setTimeout(() => {
    const key = `${state.round}:${state.media.trackId}`;
    if (animeLongLoadToastRef.current === key) return;
    animeLongLoadToastRef.current = key;
    notify.info("Chargement du theme plus long que prevu...");
  }, ANIME_MEDIA_LONG_LOAD_TOAST_MS);

  const extremeId = window.setTimeout(() => {
    handleAnimeMediaUnavailable({ force: true });
  }, ANIME_MEDIA_EXTREME_TIMEOUT_MS);

  return () => {
    window.clearTimeout(longToastId);
    window.clearTimeout(extremeId);
  };
}, [animePlaybackStatus, roomCode, session.playerId, state, usingAnimeVideoPlayback]);
```

The implementation can use a cleaner variant, but the behavior must match:

- one informational toast only,
- no report at `15s`,
- one terminal report only after the extreme timeout.

**Step 3: Mirror projection-side next-track preload on the player page**

Add player-page equivalents of the existing projection-side preload elements:

```ts
const nextAnimeVideoSource =
  state?.nextMedia?.provider === "animethemes" ? (state.nextMedia.sourceUrl ?? null) : null;
const nextAnimePreloadRef = useRef<HTMLVideoElement | null>(null);
```

Add the preload effect only once the current AnimeThemes media is stable:

```ts
const canPreloadNextAnime =
  (animePlaybackStatus === "ready" || animePlaybackStatus === "playing") &&
  Boolean(nextAnimeVideoSource);
```

Then mirror the `view.tsx` pattern:

```ts
useEffect(() => {
  const selector = "link[data-kwizik-next-anime-preload='true']";
  const head = document.head;
  const existing = head.querySelector(selector) as HTMLLinkElement | null;

  if (!canPreloadNextAnime || !nextAnimeVideoSource) {
    existing?.remove();
    const preloadVideo = nextAnimePreloadRef.current;
    if (preloadVideo) {
      preloadVideo.pause();
      preloadVideo.removeAttribute("src");
    }
    return;
  }

  const link = existing ?? document.createElement("link");
  link.setAttribute("data-kwizik-next-anime-preload", "true");
  link.setAttribute("rel", "preload");
  link.setAttribute("as", "video");
  link.setAttribute("href", nextAnimeVideoSource);
  if (!existing) head.appendChild(link);

  const preloadVideo = nextAnimePreloadRef.current;
  if (preloadVideo && preloadVideo.getAttribute("src") !== nextAnimeVideoSource) {
    preloadVideo.setAttribute("src", nextAnimeVideoSource);
    preloadVideo.load();
  }
}, [canPreloadNextAnime, nextAnimeVideoSource]);
```

Render the hidden preload video near the bottom of the component:

```tsx
<video
  ref={nextAnimePreloadRef}
  className="blindtest-preload-video"
  preload="auto"
  muted
  playsInline
  aria-hidden="true"
/>
```

**Step 4: Run frontend tests**

Run:

```bash
bun test apps/web/src/routes/room-play-anime.spec.tsx apps/web/src/routes/live-gameplay.spec.tsx apps/web/src/lib/notify.spec.ts
```

Expected: PASS, with no regressions in notify support or live-round typing.

**Step 5: Commit**

```bash
git add apps/web/src/routes/room/\$roomCode/play.tsx apps/web/src/routes/room-play-anime.spec.tsx apps/web/src/routes/live-gameplay.spec.tsx apps/web/src/lib/notify.spec.ts
git commit -m "feat: harden animethemes playback fallback and preload next round"
```

### Task 5: Run end-to-end verification and document outcomes

**Files:**
- Modify: `progress.md`

**Step 1: Run targeted API and web tests**

Run:

```bash
bun test apps/api/tests/room-store.spec.ts apps/api/tests/quiz-routes.spec.ts
bun test apps/web/src/routes/room-play-anime.spec.tsx apps/web/src/routes/live-gameplay.spec.tsx apps/web/src/lib/notify.spec.ts
```

Expected: PASS.

**Step 2: Run the web build**

Run:

```bash
cd apps/web && bun run build
```

Expected: PASS.

**Step 3: Manually validate the target behavior**

Use the existing local flow and confirm:

- AnimeThemes rounds no longer auto-skip after short stalls.
- The player page no longer reports `media/unavailable` in `15s`.
- The next AnimeThemes round begins with reduced buffering after the current round reaches `ready` or `playing`.
- Manual skip still works immediately.

**Step 4: Update progress tracking**

Add a short entry to `progress.md` describing:

- extreme-timeout-only AnimeThemes fallback,
- player-side next-track preload,
- tests/build executed.

**Step 5: Commit**

```bash
git add progress.md
git commit -m "docs: record animethemes loading resilience verification"
```
