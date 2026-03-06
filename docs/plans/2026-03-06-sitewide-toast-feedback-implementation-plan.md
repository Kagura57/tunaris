# Sitewide Toast Feedback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace legacy inline transient feedback with a global Sonner-based toast system across the web app, while preserving inline field validation and persistent loading states.

**Architecture:** Mount one global `<Toaster />` in the root layout, route all transient feedback through a shared `notify.ts` wrapper, and migrate route mutations/query-error handlers to emit deduplicated toasts instead of scattered `p.status` error blocks. Keep long-lived room/media states in-page, and add keyed deduplication for AnimeThemes playback failures so retries do not spam notifications.

**Tech Stack:** Bun, TypeScript, React 19, TanStack Router, TanStack Query, Sonner, Playwright, Vitest.

---

### Task 1: Add Toast Foundation and Dedupe Wrapper

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/routes/__root.tsx`
- Modify: `apps/web/src/styles.css`
- Create: `apps/web/src/lib/notify.ts`
- Test: `apps/web/src/lib/notify.spec.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(() => "toast-1"),
    error: vi.fn(() => "toast-1"),
    info: vi.fn(() => "toast-1"),
    loading: vi.fn(() => "toast-1"),
    dismiss: vi.fn(),
  },
}));

it("deduplicates repeated keyed error toasts", async () => {
  const { notify } = await import("./notify");
  notify.error("Lecture impossible", { key: "media:track-1" });
  notify.error("Lecture impossible", { key: "media:track-1" });
  expect((await import("sonner")).toast.error).toHaveBeenCalledTimes(1);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/lib/notify.spec.ts`  
Expected: FAIL because `notify.ts` does not exist yet.

**Step 3: Write minimal implementation**

Install dependency in the web workspace and create the wrapper:

```ts
import { toast } from "sonner";

const activeKeys = new Map<string, string | number>();

function dedupe(key: string | undefined, factory: () => string | number) {
  if (!key) return factory();
  const existing = activeKeys.get(key);
  if (existing) return existing;
  const id = factory();
  activeKeys.set(key, id);
  return id;
}

export const notify = {
  success(message: string, options?: { key?: string }) {
    return dedupe(options?.key, () => toast.success(message));
  },
  error(message: string, options?: { key?: string }) {
    return dedupe(options?.key, () => toast.error(message));
  },
};
```

Mount a single `<Toaster />` in [__root.tsx](/home/bboime/WebstormProjects/kwizik/apps/web/src/routes/__root.tsx) and add toast-specific classes in [styles.css](/home/bboime/WebstormProjects/kwizik/apps/web/src/styles.css).

**Step 4: Run tests to verify they pass**

Run: `bun test apps/web/src/lib/notify.spec.ts`  
Expected: PASS.

Run: `cd apps/web && bun run build`  
Expected: PASS and bundle includes Sonner without route/layout errors.

**Step 5: Commit**

```bash
git add apps/web/package.json apps/web/src/routes/__root.tsx apps/web/src/styles.css apps/web/src/lib/notify.ts apps/web/src/lib/notify.spec.ts
git commit -m "feat(web): add global toast foundation"
```

---

### Task 2: Migrate Auth, Home, and Join Feedback to Toasts

**Files:**
- Modify: `apps/web/src/routes/auth.tsx`
- Modify: `apps/web/src/routes/index.tsx`
- Modify: `apps/web/src/routes/join.tsx`
- Test: `apps/web/e2e/toast-feedback.spec.ts`

**Step 1: Write the failing test**

Add a Playwright spec that mocks join failure and auth failure, then asserts toast text is visible:

```ts
test("shows a toast when join fails", async ({ page }) => {
  await page.route("**/api/quiz/join", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "ROOM_NOT_FOUND" }),
    });
  });

  await page.goto("/join");
  await page.getByPlaceholder("Code room").fill("ABC123");
  await page.getByPlaceholder("Ton pseudo").fill("Kagura");
  await page.getByRole("button", { name: /Entrer dans la room/i }).click();
  await expect(page.getByText("Impossible de rejoindre cette room.")).toBeVisible();
});
```

**Step 2: Run test to verify it fails**

Run: `npx playwright test apps/web/e2e/toast-feedback.spec.ts --grep "join fails"`  
Expected: FAIL because the route still renders inline status text instead of a toast.

**Step 3: Write minimal implementation**

In each mutation:

```ts
const joinMutation = useMutation({
  mutationFn: joinRoom,
  onError: (error) => {
    notify.error(joinErrorMessage(error), { key: "join:error" });
  },
});
```

Do the same for:

- sign-in / sign-up errors in [auth.tsx](/home/bboime/WebstormProjects/kwizik/apps/web/src/routes/auth.tsx)
- create room errors in [index.tsx](/home/bboime/WebstormProjects/kwizik/apps/web/src/routes/index.tsx)
- join room errors in [index.tsx](/home/bboime/WebstormProjects/kwizik/apps/web/src/routes/index.tsx) and [join.tsx](/home/bboime/WebstormProjects/kwizik/apps/web/src/routes/join.tsx)

Remove only the transient `p.status` blocks that duplicate these mutation outcomes.

**Step 4: Run tests to verify they pass**

Run: `npx playwright test apps/web/e2e/toast-feedback.spec.ts --grep "join fails"`  
Expected: PASS.

Run: `cd apps/web && bun run build`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/routes/auth.tsx apps/web/src/routes/index.tsx apps/web/src/routes/join.tsx apps/web/e2e/toast-feedback.spec.ts
git commit -m "feat(web): migrate auth and room entry feedback to toasts"
```

---

### Task 3: Migrate Settings Feedback to Toasts While Keeping Persistent Inline States

**Files:**
- Modify: `apps/web/src/routes/settings.tsx`
- Test: `apps/web/e2e/toast-feedback.spec.ts`

**Step 1: Write the failing test**

Extend the Playwright spec with a mocked settings mutation failure:

```ts
test("shows a toast when title preference update fails", async ({ page }) => {
  await page.route("**/api/account/preferences/title", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "HTTP_UNKNOWN" }),
    });
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: /English/i }).click();
  await expect(page.getByText("Impossible de mettre a jour la preference de titre.")).toBeVisible();
});
```

**Step 2: Run test to verify it fails**

Run: `npx playwright test apps/web/e2e/toast-feedback.spec.ts --grep "title preference update fails"`  
Expected: FAIL because the error is still only rendered in the bottom inline status area.

**Step 3: Write minimal implementation**

Move mutation outcomes to `notify` callbacks:

```ts
const updateTitlePreferenceMutation = useMutation({
  mutationFn: updateTitlePreference,
  onSuccess: () => notify.success("Preference de titre mise a jour."),
  onError: () => notify.error("Impossible de mettre a jour la preference de titre.", {
    key: "settings:title-preference:error",
  }),
});
```

Apply the same treatment to:

- AniList sync launch result
- sign-out result/failure

Keep inline:

- library loading
- library empty state
- static explanatory copy

**Step 4: Run tests to verify they pass**

Run: `npx playwright test apps/web/e2e/toast-feedback.spec.ts --grep "title preference update fails"`  
Expected: PASS.

Run: `cd apps/web && bun run build`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/routes/settings.tsx apps/web/e2e/toast-feedback.spec.ts
git commit -m "feat(web): move settings mutation feedback to toasts"
```

---

### Task 4: Migrate Room Action Feedback and Projection Audio Feedback

**Files:**
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/src/routes/room/$roomCode/view.tsx`
- Modify: `apps/web/src/routes/room-play-anime.spec.tsx`

**Step 1: Write the failing test**

Add a lightweight guard test to verify the room player route uses the notification wrapper for media/action feedback:

```ts
it("uses notify helpers for anime playback feedback", () => {
  const file = readFileSync("apps/web/src/routes/room/$roomCode/play.tsx", "utf8");
  expect(file).toContain("notify.error(");
  expect(file).toContain("notify.info(");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/routes/room-play-anime.spec.tsx`  
Expected: FAIL because `play.tsx` does not yet call `notify`.

**Step 3: Write minimal implementation**

In [play.tsx](/home/bboime/WebstormProjects/kwizik/apps/web/src/routes/room/$roomCode/play.tsx):

- move transient mutation/query failures out of the bottom generic `p.status` block and into targeted `notify` calls
- keep persistent loading text for playlist preparation and media loading inline
- toast room/session expiry events once before navigation

In [view.tsx](/home/bboime/WebstormProjects/kwizik/apps/web/src/routes/room/$roomCode/view.tsx):

```ts
useEffect(() => {
  if (!audioError || usingYouTubePlayback || usingAnimeVideoPlayback) return;
  notify.error("Erreur audio sur la piste en cours.", {
    key: `projection:audio:${state?.round ?? 0}:${state?.media?.trackId ?? "unknown"}`,
  });
}, [audioError, state?.round, state?.media?.trackId, usingAnimeVideoPlayback, usingYouTubePlayback]);
```

**Step 4: Run tests to verify they pass**

Run: `bun test apps/web/src/routes/room-play-anime.spec.tsx`  
Expected: PASS.

Run: `cd apps/web && bun run build`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/routes/room/$roomCode/play.tsx apps/web/src/routes/room/$roomCode/view.tsx apps/web/src/routes/room-play-anime.spec.tsx
git commit -m "feat(web): migrate room action feedback to toasts"
```

---

### Task 5: Add AnimeThemes Media Error Dedupe and End-to-End Coverage

**Files:**
- Modify: `apps/web/src/lib/notify.ts`
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/e2e/live-blindtest.spec.ts`
- Modify: `apps/web/e2e/toast-feedback.spec.ts`

**Step 1: Write the failing test**

Extend the anime playback Playwright spec so repeated failed media requests only produce one visible toast:

```ts
test("shows a single toast for repeated anime media failures on one track", async ({ page }) => {
  let mediaRequests = 0;

  await page.route("**/quiz/media/animethemes/**", async (route) => {
    mediaRequests += 1;
    await route.fulfill({ status: 503, body: "UPSTREAM_UNAVAILABLE" });
  });

  await page.goto("/room/ABC123/play");

  await expect(page.getByText("Lecture du theme impossible. Passage au round suivant...")).toHaveCount(1);
  expect(mediaRequests).toBeGreaterThan(1);
});
```

**Step 2: Run test to verify it fails**

Run: `npx playwright test apps/web/e2e/live-blindtest.spec.ts --grep "single toast"`  
Expected: FAIL because repeated playback failures currently emit repeated notifications or no toast at all.

**Step 3: Write minimal implementation**

Use keyed toast emission in the anime error path:

```ts
notify.error("Lecture du theme impossible. Passage au round suivant...", {
  key: `anime-media:${roomCode}:${state.round}:${state.media.trackId}:unavailable`,
});
```

Also dismiss/reset the key when:

- track changes
- round changes
- playback recovers for a different track

**Step 4: Run tests to verify they pass**

Run: `npx playwright test apps/web/e2e/live-blindtest.spec.ts --grep "single toast"`  
Expected: PASS.

Run: `npx playwright test apps/web/e2e/toast-feedback.spec.ts`  
Expected: PASS.

Run: `cd apps/web && bun run build`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/lib/notify.ts apps/web/src/routes/room/$roomCode/play.tsx apps/web/e2e/live-blindtest.spec.ts apps/web/e2e/toast-feedback.spec.ts
git commit -m "fix(web): dedupe anime playback error toasts"
```

---

### Task 6: Remove Redundant Inline Status Blocks and Preserve Only Persistent Inline States

**Files:**
- Modify: `apps/web/src/routes/auth.tsx`
- Modify: `apps/web/src/routes/index.tsx`
- Modify: `apps/web/src/routes/join.tsx`
- Modify: `apps/web/src/routes/settings.tsx`
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/src/routes/room/$roomCode/view.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/routes/room-play-anime.spec.tsx`

**Step 1: Write the failing test**

Add a guard that the old generic inline media error text is no longer the primary feedback path:

```ts
it("does not keep the legacy inline anime media error sentence in the room status block", () => {
  const file = readFileSync("apps/web/src/routes/room/$roomCode/play.tsx", "utf8");
  expect(file).not.toContain('Erreur media: theme indisponible.');
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/routes/room-play-anime.spec.tsx`  
Expected: FAIL before the legacy inline strings are removed.

**Step 3: Write minimal implementation**

- remove redundant generic `p.status error` blocks that now duplicate toast messages
- keep `.status` styling for helper text and persistent inline informational states only
- leave form hints and future field validation hooks intact

Update CSS so `.status` remains useful as secondary copy, not as the primary error delivery system.

**Step 4: Run tests to verify they pass**

Run: `bun test apps/web/src/routes/room-play-anime.spec.tsx apps/web/src/routes/routes.spec.tsx apps/web/src/routes/layout.spec.tsx`  
Expected: PASS.

Run: `cd apps/web && bun run build`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/routes/auth.tsx apps/web/src/routes/index.tsx apps/web/src/routes/join.tsx apps/web/src/routes/settings.tsx apps/web/src/routes/room/$roomCode/play.tsx apps/web/src/routes/room/$roomCode/view.tsx apps/web/src/styles.css apps/web/src/routes/room-play-anime.spec.tsx
git commit -m "refactor(web): remove legacy inline transient feedback"
```
