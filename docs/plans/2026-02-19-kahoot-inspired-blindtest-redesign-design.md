# Kahoot-Inspired Blindtest Rebuild Design

- Date: 2026-02-19
- Project: Tunaris
- Status: Approved

## 1. Product Direction

### Objective
Rebuild Tunaris from prototype-level UX/backend into a production-grade web blindtest experience that feels competitive, fast, and desirable to play, inspired by Kahoot/Quizizz live game patterns.

### Core Product Decisions (Validated)
- Live host-led session flow.
- Host can play: no gameplay distinction between host and players.
- Web first (desktop-first acceptable), responsive baseline only for now.
- Blindtest rounds (not generic quiz questions).
- Host configures round count.
- Round answer mode is mixed: multiple-choice and free-text.
- Round timing default:
  - Countdown: 3s
  - Play: 12s
  - Reveal: 4s
- Scoring: correctness + speed.
- Guests allowed (account optional).
- Authentication strategy: Better Auth.
- Music sourcing: live providers only when previewUrl is available and directly playable.
- Player cap: no fixed default product cap unless host explicitly configures `maxPlayers`.

## 2. UX Benchmark Principles

### Reference Patterns Adopted
- PIN/code room join flow for instant onboarding.
- Strong visual momentum between phases (lobby, countdown, play, reveal, leaderboard).
- Prominent timer and submission confidence feedback.
- Frequent ranking updates to increase engagement.
- Clear replay loop at match end.

### Experience Goals
- Join-to-play in under 20 seconds for guests.
- Immediate understanding of current game phase.
- Zero ambiguity about submission accepted/rejected state.
- Legible score progression every round.

## 3. Information Architecture

### Routes (Web)
- `/` Landing + create/join entry.
- `/join` Player join form (room code + display name).
- `/room/:roomCode/play` Unified participant gameplay screen.
- `/room/:roomCode/view` Projection/host-controlled display (leaderboard-first visual).
- `/auth` Optional account login/register.
- `/history` Personal match history + stats (account only).

### Role Model
- Participant is the only gameplay role.
- Host has orchestration permissions only (start match, continue, replay), not gameplay advantages.

## 4. Backend Architecture

### Runtime
- `apps/api` with Elysia remains authoritative game engine.
- Deterministic room state machine:
  - `lobby -> countdown -> playing -> reveal -> leaderboard -> (next round | results)`

### Realtime Model
- Primary transport: WebSocket channels scoped by room.
- Fallback: snapshot endpoint + client resync on reconnect.
- Server timestamps are authoritative for deadlines and state transitions.

### Persistence Strategy
- Remove JSON-based auth/history stores from production path.
- Persist to Postgres with transactional writes.
- Keep room runtime state in memory for active matches in V1, persist outputs/events for recovery and stats.

## 5. Authentication and Identity

### Better Auth
- Better Auth integrated into Elysia.
- Guest participation supported without account.
- Account users can:
  - keep persistent identity,
  - access history and profile statistics.

### Session Security
- Secure cookie/session defaults from Better Auth docs.
- Rate limiting on auth endpoints.
- Password policies and secure storage delegated to Better Auth adapters.

## 6. Data Model (Initial)

### Core Tables
- `users` (Better Auth adapter-owned)
- `profiles`
- `matches`
- `match_participants`
- `rounds`
- `round_submissions`
- `provider_tracks` (normalized preview metadata cache)

### Important Fields
- `matches.config` includes:
  - `roundCount`
  - `maxPlayers` (nullable)
  - `answerModes` strategy
- `rounds` includes:
  - `phase timings`
  - `track provider + preview url`
- `round_submissions` includes:
  - `submittedAt`
  - `accepted`
  - `answerType`
  - scoring breakdown

## 7. Blindtest Engine Rules

### Track Eligibility
A round can only start if a playable `previewUrl` is available.

### Submission Rules
- One accepted submission per participant per round.
- Submission after deadline is rejected.
- Free-text answers use normalization + fuzzy matching thresholds.
- QCM uses strict option id match.

### Scoring Rules
- Correct answer required for non-zero score.
- Speed multiplier decreases over play window.
- Streak applies multiplicative bonus with cap.
- Tie-breakers:
  1. total score
  2. best streak
  3. lower average response time

## 8. Reliability and Failure Handling

### Provider Failures
- Timeout and fallback sequence per provider.
- If no valid preview source for a candidate round, skip candidate and continue pool resolution.
- If pool incomplete, show explicit controlled error before game start.

### Reconnect/Resync
- Client reconnect fetches room snapshot.
- If phase drift detected, client snaps to server phase/deadline.

### Anti-Cheat / Fairness
- Deadlines and acceptance are server-only.
- Score computation is server-only.
- Client only renders authoritative events and local optimistic UI states.

## 9. Testing Strategy

### Unit
- Score engine and streak edge cases.
- Free-text matcher thresholds.
- State machine transition timings.

### Integration
- Create/join/start/full round cycle with both answer modes.
- Better Auth flows (guest + authenticated user mix).
- Match persistence and history query consistency.

### E2E
- Host starts game while joining as participant.
- Multi-player round progression and leaderboard updates.
- Auth optional flow + history access.

### Quality Gates
- `bun run lint`
- `bun run test`
- `npx playwright test`
- Build checks for web and api.

## 10. Out of Scope (This Rebuild Phase)

- Native mobile-specific UX parity.
- Monetization/payments.
- Social graph and advanced profile systems.
- Massive-scale multi-region orchestration.

