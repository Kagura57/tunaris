# Sitewide Toast Feedback Design

**Date:** 2026-03-06  
**Status:** Approved  
**Scope:** Replace legacy inline transient feedback with a global toast system across the web app, while keeping useful persistent state and field-level validation inline.

---

## 1. Goal

Kwizik currently mixes several feedback patterns:

- generic inline `p.status` blocks in forms and route layouts
- long-lived overlays/banners for media and playlist preparation
- local one-off error text in room playback/projection screens

This change standardizes transient feedback around a single global toast system so that success, error, info, and in-flight action feedback feel modern, consistent, and less noisy.

Out of scope for this change:

- full form redesign
- replacing long-lived loading UI with toasts
- changing backend APIs or game state behavior

---

## 2. Library Decision

### 2.1 Options reviewed

- **Sonner**
  - modern default presentation
  - global `<Toaster />` model
  - small API surface for `toast()`, actions, and promise lifecycle handling
- **react-hot-toast**
  - lightweight and reliable
  - strong headless API
  - visually more neutral out of the box
- **notistack**
  - robust snackbar stack
  - better fit for apps already using a component system such as MUI

### 2.2 Decision

Use **Sonner** with a local wrapper module `apps/web/src/lib/notify.ts`.

Reasoning:

- best “modern by default” presentation for the least custom code
- straightforward global mounting model
- good support for action toasts and promise-driven lifecycle
- easy to wrap so the app does not depend on raw library calls everywhere

### 2.3 Research sources

- Sonner package/docs: <https://www.npmjs.com/package/sonner>
- react-hot-toast docs: <https://react-hot-toast.com/>
- react-hot-toast package: <https://www.npmjs.com/package/react-hot-toast>
- notistack docs: <https://notistack.com/getting-started>

---

## 3. Product Contract

### 3.1 What becomes a toast

Use toasts for transient feedback such as:

- authentication success/failure
- create/join room success/failure
- host actions in the lobby
- settings mutations and account actions
- room expiry / session invalidation notices
- transient API failures
- AnimeThemes playback failure and automatic skip notices
- copy/share confirmations

### 3.2 What stays inline

Keep inline UI for:

- field-level validation
- form hints and helper text
- persistent room and media loading states
- list/library empty states
- long-lived playlist preparation states already represented by page UI

### 3.3 Tone and behavior

Toast copy must be:

- short
- non-technical
- action-oriented
- deduplicated when the same event repeats rapidly

Examples:

- `Room créée.`
- `Impossible de rejoindre cette room.`
- `Lecture du thème impossible. Passage au round suivant...`
- `Déconnexion impossible pour le moment.`

---

## 4. UX Rules

### 4.1 Placement and visual behavior

- Desktop: top-right stack
- Mobile: centered or near-centered top stack with full-width safe margins
- Maximum visible toasts: 3 or 4
- Success duration shorter than error duration
- Loading toast remains visible until resolved or dismissed

### 4.2 Variants

- `success`
- `error`
- `info`
- `loading`

Future-safe, but not required in this phase:

- `warning`
- undo/action-heavy destructive confirmations

### 4.3 Anti-spam

The system must deduplicate repeated events by a stable key.

Important cases:

- repeated media failures for the same AnimeThemes track
- repeated room sync failures during query polling
- repeated room action errors triggered by fast retry clicks

Rule:

- one toast per `(scope, reason, optional trackId/roomCode)` while the event is active
- allow a new toast once the previous key is dismissed or naturally expires

### 4.4 Accessibility

- use the library’s `aria-live` support
- allow keyboard dismissal
- maintain readable contrast on light backgrounds
- avoid using toasts for high-density validation that users need to cross-reference with specific fields

---

## 5. Architecture

### 5.1 Global host

Mount a single `<Toaster />` at the app shell level so it survives route transitions.

Preferred location:

- `apps/web/src/routes/__root.tsx`

This keeps the toast system available on all pages, including room routes.

### 5.2 Notification wrapper

Create `apps/web/src/lib/notify.ts` with a stable public API:

- `notify.success(message, options?)`
- `notify.error(message, options?)`
- `notify.info(message, options?)`
- `notify.loading(message, options?)`
- `notify.promise(promise, labels, options?)`
- `notify.dismiss(idOrKey?)`

Responsibilities:

- deduplicate repeated events via a `key`
- centralize shared defaults like duration and action labels
- keep route files free from raw `sonner` usage

### 5.3 Message mapping

Map frequent backend errors to user-facing copy in one place instead of duplicating strings inside every route.

Examples:

- `ROOM_NOT_FOUND`
- `ROOM_NOT_JOINABLE`
- `PLAYER_NOT_FOUND`
- `HOST_ONLY`
- `SPOTIFY_RATE_LIMITED`
- AniList sync error codes

This mapping can live in `notify.ts` or a small adjacent helper if the file grows too large.

### 5.4 Emission strategy

Do **not** add a global “toast every failed HTTP request” interceptor.

Use controlled emission from:

- mutation `onSuccess` / `onError`
- targeted `useEffect` blocks for query failures that should notify
- targeted media error handlers in anime playback code

This avoids noise from background polling and repeated expected failures.

---

## 6. Migration Scope by Screen

### 6.1 Auth, home, join

Replace generic `p.status` mutation feedback with toasts in:

- `apps/web/src/routes/auth.tsx`
- `apps/web/src/routes/index.tsx`
- `apps/web/src/routes/join.tsx`

Keep field labels, placeholders, and any future field-level validation inline.

### 6.2 Settings

Use toasts for:

- title preference update result
- AniList sync launch result
- sign-out result
- other mutation failures that are currently rendered in the shared bottom status block

Keep inline:

- library loading state
- library empty state
- static explanatory text

### 6.3 Room player screen

In `apps/web/src/routes/room/$roomCode/play.tsx`:

- replace transient error/success lines from the bottom `p.status` block with toasts
- keep persistent overlays such as media loading and track preparation in-page
- keep non-toast room state indicators that are part of gameplay, not transient notifications

### 6.4 Room projection screen

In `apps/web/src/routes/room/$roomCode/view.tsx`:

- replace the isolated “Erreur audio sur la piste en cours” inline error with a toast
- keep projection loading overlays in-page

---

## 7. AnimeThemes / Media Error Design

AnimeThemes delivery errors can happen in bursts because browsers retry ranged media requests.

Rules:

- toast only on the first meaningful playback failure for a given track/phase
- dedupe by `media:<roomCode>:<round>:<trackId>:<reason>`
- use human wording, never expose raw `DOMException` or HTTP range details
- if the app already auto-skips, phrase the toast accordingly

Preferred copy:

- `Lecture du thème impossible. Passage au round suivant...`
- `Impossible de signaler le thème indisponible. Utilise Skip pour continuer.` only when reporting itself fails

Do not toast:

- every retry attempt
- every `waiting` or `buffering` event
- every `Range` request failure if the UI already handled the incident

---

## 8. Styling Direction

The new toast system should match Kwizik’s established visual language instead of shipping library defaults untouched.

Requirements:

- reuse existing color variables where possible
- sharp but not noisy contrast
- compact surface with subtle blur/shadow
- clear distinction between success/error/info
- avoid old “flat grey sentence at the bottom of a panel” look

Keep `.status` styles only for:

- helper text
- inline field errors
- persistent non-toast informational copy

---

## 9. Testing Strategy

### 9.1 Unit

Add tests for `notify.ts`:

- keyed deduplication
- dismissal by key/id
- variant forwarding to the underlying toast library

### 9.2 Route / source-level guard tests

Update or add lightweight route tests to ensure:

- the global toaster is mounted
- room playback code uses the toast wrapper for media failures

### 9.3 Playwright

Add/extend end-to-end coverage for:

- join/create/auth error toasts
- settings mutation feedback
- anime media failure deduplication in the room player flow

### 9.4 Manual verification

Verify:

- desktop and mobile placement
- no overlap with topbar in standard breakpoints
- no toast spam during playback retries
- room routes still show persistent overlays correctly

---

## 10. Rollout Notes

- Migrate the highest-noise routes first: `auth`, `index`, `join`, `settings`, then room playback/projection.
- Keep copy centralized so future wording changes do not require hunting through route files.
- Prefer small commits by area to keep regressions contained.
- Leave full inline field-state modernization for a follow-up after the toast migration settles.
