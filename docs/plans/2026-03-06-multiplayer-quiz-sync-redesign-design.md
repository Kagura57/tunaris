# Multiplayer Quiz Sync Redesign Design

## Goal

Redesign multiplayer quiz playback so AnimeThemes rounds start at nearly the same time for all remote players, remain reactive between rounds, and stop relying on fragile browser-local readiness heuristics.

## Problem

The current flow mixes three concerns that should be separated:

- round orchestration is server-driven but still modeled as `loading -> playing` without a true shared start timestamp;
- critical room transitions still depend on HTTP polling, which is too coarse for a music quiz;
- client media lifecycle events (`loadeddata`, `canplay`, stalls, retries) are currently tied too closely to room progression.

In practice this creates three visible failures:

- one player can appear "ready" too early and start the round with a fragile buffer;
- another player can still be buffering while others are already playing;
- client-side preload of future AnimeThemes media can increase network pressure without producing a shared benefit.

## Product Requirements

- Every player hears the round on their own device.
- The round should begin for everyone on a shared timeline, not "whenever the browser is ready."
- The experience must stay fast: transitions should remain short and feel quiz-like.
- A single slow client must not permanently block the room.
- Late clients must be able to rejoin the canonical timeline cleanly.

## Constraints

- The current app uses HTTP snapshot polling for room state.
- AnimeThemes playback is proxied through the API, but the proxy does not yet provide a shared cache layer.
- The redesign must preserve answer timing fairness across players.
- The redesign must support remote players who are not physically in the same room.

## Chosen Direction

### 1. Replace implicit round start with a server-authoritative timeline

The server must become the only authority for when a round starts.

Each prepared round should expose:

- `serverNowMs`
- `plannedStartAtMs`
- `guessDeadlineMs`
- `phaseToken`
- `trackId`
- `mediaOffsetSec`

Clients should no longer infer round start from local media events. Instead, they should load the media, seek to the planned offset, and start playback against the shared `plannedStartAtMs`.

### 2. Demote `mediaReady` from phase gate to telemetry

The existing `mediaReady` concept should stop acting as a global unlock for the room.

It can remain useful as a client signal, but only as part of orchestration and observability:

- `client_prepared`
- `client_started`
- `client_late`
- `client_failed`

The round should not require unanimous browser-level readiness to begin.

### 3. Use quorum-based scheduling, not unanimity

The server should schedule the round once a short readiness window closes.

Recommended quorum policy:

- solo: `1/1`
- two players: `2/2` with a short hard cap
- three or more players: host plus majority, or a short maximum wait such as `2s`

This preserves fairness without letting one slow client stall the entire room.

Late clients should join the existing timeline by seeking to the current server-derived position instead of delaying everyone else.

### 4. Move real preloading to the API proxy

Client-side preload of future AnimeThemes rounds should not be part of the synchronization strategy.

Instead, the API proxy should provide:

- shared cache for AnimeThemes media;
- single-flight deduplication for concurrent requests;
- warm-up of the next round (`N+1`) as soon as the current round is scheduled.

This keeps transitions short without multiplying upstream traffic for each player.

### 5. Introduce a real-time transport for critical transitions

HTTP polling should no longer be responsible for critical phase changes.

Use a dedicated real-time channel, preferably WebSocket, for:

- `prepare_round`
- `round_started`
- `round_resync`
- `round_invalidated`
- client acknowledgements such as `client_prepared` and `client_started`

HTTP snapshot endpoints remain useful as fallback and recovery paths, but not as the primary real-time mechanism.

## Round Lifecycle

### Phase 1: `prepare_round`

The server announces the next round with:

- track identity and source URL;
- canonical media offset;
- tentative or final `plannedStartAtMs`;
- answer deadline;
- phase token.

Clients begin loading immediately.

### Phase 2: `client_prepared`

Clients acknowledge that the round can be started locally:

- media resource resolved;
- seek to `mediaOffsetSec` possible;
- enough local readiness to launch playback.

This signal informs the server but does not directly unlock the room.

### Phase 3: `round_started`

The server commits to a shared `startAtMs`.

Clients schedule playback against that timestamp. The room's fairness comes from the shared timeline, not from matching browser event order.

### Phase 4: `late_join / resync`

If a client starts late or stalls briefly:

- it should calculate the expected playback position from server time;
- seek to that point;
- continue the round without affecting others.

## UX

- Replace long ambiguous loading phases with a short preparation state and a tight common countdown.
- Keep toasts local and actionable:
  - short preparation delay;
  - local resynchronization;
  - unrecoverable media failure.
- Do not expose internal browser media instability as global room logic.

## Code to Remove or Simplify

- Polling-based critical synchronization in player and projection routes.
- Server logic that treats unanimous `mediaReady` as the normal fast path.
- Browser-side preload of future AnimeThemes rounds.
- Tight coupling between HTML media events and room state advancement.
- Stall heuristics that currently act as synchronization rules instead of local recovery signals.

## Rollout Strategy

1. Add server timeline fields to room state while keeping current transport.
2. Teach clients to schedule playback from `plannedStartAtMs`.
3. Replace `mediaReady` gating with quorum-based round scheduling.
4. Introduce WebSocket for critical transitions.
5. Add shared proxy caching and next-round warm-up.
6. Remove dead synchronization code and old preload logic.

## Success Metrics

- Median start skew between players.
- P95 start skew between players.
- Median preparation time between rounds.
- Resync frequency per round.
- AnimeThemes proxy upstream fetch count per round.
- Round invalidation rate due to unrecoverable media failure.

## Non-Goals

- Shared-room speaker/projection-only playback.
- Full future-quiz media exposure to clients.
- Permanent large-scale media storage.
- Perfect sample-level sync across heterogeneous browsers.
