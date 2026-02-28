# Anime Quiz Wave Media Loop Design

**Date:** 2026-02-28  
**Status:** Approved  
**Scope:** Merge the wave bar and reveal video areas into a single media container, and enforce AMQ-like 20s/20s loop with unanimous skip gates.

---

## 1. Product Contract

Round contract for Anime Quiz mode:

- Phase A (`playing` / guessing): max 20 seconds.
- Phase B (`reveal`): max 20 seconds.
- If all active players are done before timeout, phase ends immediately.

Done condition by phase:

- Guessing done = player either submits an answer or clicks `Skip`.
- Reveal done = player clicks `Next` (skip reveal).

Multiplayer policy:

- Early transition requires unanimity among active players in the room.
- No host bypass for round skipping.
- Solo mode transitions immediately on local click.

Out of scope in this change:

- New scoring rules.
- New room states beyond current `playing/reveal/leaderboard/results` machine.

---

## 2. State Machine and Timing Design

### 2.1 Server-authoritative timing

Current architecture already uses server `deadlineMs` from `RoomStore/RoomManager`, which remains the authority.
Client clock only renders progress and never decides transitions.

Configuration changes:

- `playingMs = 20_000`
- `revealMs = 20_000`
- `leaderboardMs = 0` (keep state for compatibility but make it effectively instant)

### 2.2 Early-transition mechanics

Introduce per-round phase action tracking in `RoomManager`:

- `guessSkippedPlayerIds` (or equivalent set/map)
- `revealSkippedPlayerIds` (or equivalent set/map)

Transition rules:

- While `playing`: if every active player is in `answers` or `guessSkipped`, close round immediately and move to `reveal`.
- While `reveal`: if every active player voted `Next`, move immediately to next round (or `results` on last round).

### 2.3 Backward-compatible API surface

Keep `/quiz/skip` endpoint but change semantics:

- In `playing`: register local guess skip vote.
- In `reveal`: register local reveal-next vote.
- Return updated state snapshot metadata and phase counts.

`HOST_ONLY` for skip becomes obsolete by design.

---

## 3. UI and Media Container Design

### 3.1 Single media shell

The current wave block (`.sound-visual`) becomes the canonical media container:

- Fixed `aspect-ratio: 16 / 9`.
- `position: relative`, `overflow: hidden`.
- Contains the real `<video>` element and wave/timeline overlays.

### 3.2 Guessing vs reveal visibility

During guessing (`playing`):

- Video is mounted and playing (continuous timeline preserved).
- Video layer is fully hidden (`opacity: 0`, masked, no frame leakage).
- Wave animation + timeline are visible.

During reveal (`reveal`):

- Video layer fades in.
- Wave overlay fades out.
- No `src` reset, no seek, no remount.

### 3.3 CSS structure

Refactor toward explicit layers:

- `.media-shell`
- `.media-video-layer`
- `.media-wave-layer`
- `.media-timeline-layer`
- phase modifiers: `.is-playing`, `.is-reveal`

Transition should rely on opacity/visibility only; avoid layout jumps and offscreen hacks (`left:-9999px`) for AnimeThemes video.

---

## 4. Data Flow and Snapshot Additions

Extend realtime/room snapshot with phase gate metadata:

- `guessDoneCount`
- `guessTotalCount`
- `revealSkipCount`
- `revealSkipTotalCount`
- Optional current-player phase action for button lock UX

Frontend uses these fields to:

- Render quorum progress (`2/4 prêts à passer`).
- Disable skip/next button after local vote.
- Show "En attente des autres...".

---

## 5. Error Handling and Edge Cases

- If a player leaves mid-phase, totals are recalculated against current active players and unanimity checks re-evaluate immediately.
- If phase timeout hits before unanimity, normal deadline transition still applies.
- If reveal skip vote arrives in non-reveal/non-playing states, endpoint returns `INVALID_STATE`.
- Media playback error remains non-blocking for state machine transitions.

---

## 6. Test Strategy

### Unit / state-machine

- `playing` ends early when all players are answered-or-skipped.
- `reveal` ends early when all players voted next.
- Last-round reveal skip transitions directly to `results`.

### Integration (RoomStore)

- Verify 20s/20s deadlines.
- Verify skip endpoint behavior in both phases.
- Verify counts exposed in room snapshot.

### UI

- Ensure skip button appears in `playing`, next button in `reveal`.
- Ensure media shell keeps one continuous video element and switches visibility by phase.
- Ensure wave/video transition classes toggle correctly.

---

## 7. Rollout Notes

- Keep `leaderboard` state for compatibility with existing consumer code and tests, but with zero duration.
- Migrate skip error messages in UI from host-only language to unanimous vote language.
- Apply same media-shell behavior in both player (`play.tsx`) and projection (`view.tsx`) screens for visual consistency.
