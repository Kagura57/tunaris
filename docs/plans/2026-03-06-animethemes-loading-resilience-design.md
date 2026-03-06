# AnimeThemes Loading Resilience Design

## Goal

Make AnimeThemes playback far more tolerant of slow upstream delivery, avoid false-positive round skips, and reduce round-to-round buffering by preloading only the next AnimeThemes media item.

## Problem

The current player treats short stalls and repeated `Range` activity as hard failures too quickly. In practice, some AnimeThemes videos continue to make useful progress for a long time before becoming playable. This creates false positives where the frontend reports `media/unavailable`, and the API immediately skips the round, even though waiting longer would have succeeded.

The current design also only preloads the next AnimeThemes video on the projection view. The player view does not do the same work, so transition buffering is still visible in normal gameplay.

## Constraints

- Do not expose the entire future quiz media queue to the browser.
- Keep manual skip behavior unchanged.
- Preserve toast-based feedback, but avoid spam during long buffering.
- Frontend and backend timeout policies must stay aligned.
- Do not attempt "preload the whole quiz" without adding a real proxy cache layer first.

## Chosen Direction

### 1. Auto-skip only in extreme cases

AnimeThemes rounds must no longer be skipped because of a short load stall, a single `play()` failure, or a few repeated media errors.

Instead, the system should distinguish three states:

- Normal buffering: no skip, no failure report.
- Abnormally long buffering: show one informational toast, keep waiting.
- Extreme failure: only after a very long no-progress window does the client report `media/unavailable`, allowing the backend to advance the round.

The target policy is a shared extreme timeout in the `60-90s` range, with the final implementation expected to use one aligned value for frontend and backend.

### 2. Align backend loading timeout with the new policy

The API currently has its own AnimeThemes loading timeout and can skip the round independently. That timeout must be raised and aligned with the same "extreme only" philosophy, otherwise the frontend could wait while the backend still skips early.

### 3. Preload one AnimeThemes round ahead

The application should keep preloading exactly one future AnimeThemes media item using `nextMedia`, without exposing more of the future track pool to the client.

This preloading should exist on the player page as well as the projection page.

The preload should start only after the current AnimeThemes media is actually stable enough to be useful, so the current round keeps priority over the next round.

If the round changes, the previous preload should be abandoned and replaced with the new `nextMedia`.

## UX

### Toast behavior

- Do not show an error toast for every transient media hiccup.
- Show at most one informational toast per track when loading becomes abnormally long.
- Show the existing failure toast only when the system truly decides the media is unavailable.

### Skip behavior

- Manual skip remains available and unchanged.
- Automatic skip becomes a last resort only.

## Non-Goals

- No preload of the entire quiz media queue.
- No browser exposure of more than the current and next media item.
- No new proxy cache implementation in this change.

## Implementation Areas

### Frontend

- `apps/web/src/routes/room/$roomCode/play.tsx`
  - Remove aggressive AnimeThemes failure escalation.
  - Track long no-progress conditions instead of short stalls.
  - Add next-track AnimeThemes preload mirroring the projection behavior.

- `apps/web/src/routes/room/$roomCode/view.tsx`
  - Keep the existing next-track preload behavior as the reference implementation.

### Backend

- `apps/api/src/services/RoomStore.ts`
  - Raise and align AnimeThemes loading timeout behavior.
  - Keep `reportMediaUnavailable()` as the final explicit extreme-failure path.

## Testing Strategy

### Frontend tests

- Verify that short stalls no longer report `media/unavailable`.
- Verify that repeated `Range` activity alone does not trigger auto-skip.
- Verify that the long-loading informational toast appears once per track.
- Verify that player-side next-track preload is activated for AnimeThemes.

### Backend tests

- Verify that AnimeThemes loading timeout uses the new extreme threshold.
- Verify that an explicit `media/unavailable` report still advances the round.
- Verify that the backend no longer skips AnimeThemes rounds on the previous short timeout.

### Manual validation

- Reproduce a long AnimeThemes buffering scenario similar to `JakuCharaTomozakiKun-OP1.webm`.
- Confirm the round waits substantially longer before considering the media unavailable.
- Confirm manual skip still works immediately.
- Confirm the next AnimeThemes round starts with less buffering after successful preload.
