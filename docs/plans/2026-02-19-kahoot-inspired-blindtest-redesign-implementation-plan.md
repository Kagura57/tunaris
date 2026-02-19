# Kahoot-Inspired Blindtest Rebuild Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild Tunaris into a modern live blindtest web app with host-led flow, unified player role (host can play), Better Auth integration, and production-grade persistence.

**Architecture:** Keep Elysia as authoritative round engine and move prototype persistence to Postgres repositories. Use Better Auth for optional accounts while allowing guests. Drive gameplay through room-scoped WebSocket events plus snapshot resync.

**Tech Stack:** Bun workspaces, TypeScript strict, Elysia, React 19, TanStack Router, TanStack Query, Zustand, Better Auth, Postgres (`pg`), Vitest, Playwright.

---

## Skill References

- `@better-auth-best-practices` for auth/session setup and secure defaults
- `@supabase-postgres-best-practices` for schema/index/query hygiene
- `@ux-principles` for interaction and usability decisions
- `@develop-web-game` for deterministic gameplay iteration loops and Playwright checks
- `@webapp-testing` for end-to-end validation
- `@executing-plans` for implementation batching

### Task 1: Establish New Shared Realtime Contracts

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/src/realtime.spec.ts`

**Step 1: Write the failing test**

```ts
// packages/shared/src/realtime.spec.ts
import { describe, expect, it } from "vitest";
import { ROOM_PHASES, type RoomRealtimeEvent } from "./index";

describe("realtime contracts", () => {
  it("exposes live blindtest phases including leaderboard", () => {
    expect(ROOM_PHASES).toContain("leaderboard");
  });

  it("supports mixed answer mode payloads", () => {
    const event: RoomRealtimeEvent = {
      type: "round_started",
      roomCode: "ABCD12",
      round: 1,
      mode: "mcq",
      deadlineMs: 123,
      choices: ["A", "B", "C", "D"],
    };

    expect(event.type).toBe("round_started");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/realtime.spec.ts`  
Expected: FAIL (missing `ROOM_PHASES`/`RoomRealtimeEvent` exports or types).

**Step 3: Write minimal implementation**

```ts
// packages/shared/src/constants.ts
export const ROOM_PHASES = [
  "lobby",
  "countdown",
  "playing",
  "reveal",
  "leaderboard",
  "results",
] as const;
```

```ts
// packages/shared/src/events.ts
export type RoomRealtimeEvent =
  | {
      type: "round_started";
      roomCode: string;
      round: number;
      mode: "mcq" | "text";
      deadlineMs: number;
      choices?: string[];
    }
  | {
      type: "round_reveal";
      roomCode: string;
      round: number;
      acceptedAnswer: string;
    }
  | {
      type: "leaderboard_updated";
      roomCode: string;
      round: number;
      entries: Array<{ playerId: string; score: number; rank: number }>;
    }
  | {
      type: "match_finished";
      roomCode: string;
    };
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/realtime.spec.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/shared/src
 git commit -m "feat(shared): add blindtest realtime phase and event contracts"
```

### Task 2: Introduce Postgres Domain Schema and DB Client

**Files:**
- Create: `apps/api/src/db/client.ts`
- Create: `apps/api/src/db/schema.sql`
- Create: `apps/api/src/db/migrate.ts`
- Create: `apps/api/tests/db-schema.spec.ts`
- Modify: `apps/api/package.json`

**Step 1: Write the failing test**

```ts
// apps/api/tests/db-schema.spec.ts
import { describe, expect, it } from "vitest";
import { DOMAIN_TABLES } from "../src/db/client";

describe("db schema contract", () => {
  it("declares blindtest domain tables", () => {
    expect(DOMAIN_TABLES).toContain("matches");
    expect(DOMAIN_TABLES).toContain("round_submissions");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/db-schema.spec.ts`  
Expected: FAIL (missing `db/client`).

**Step 3: Write minimal implementation**

```ts
// apps/api/src/db/client.ts
import { Pool } from "pg";

export const DOMAIN_TABLES = [
  "profiles",
  "matches",
  "match_participants",
  "rounds",
  "round_submissions",
  "provider_tracks",
] as const;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
```

```sql
-- apps/api/src/db/schema.sql
create table if not exists profiles (
  user_id text primary key,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists matches (
  id bigserial primary key,
  room_code text not null,
  config jsonb not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists idx_matches_room_code on matches(room_code);
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/db-schema.spec.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/db apps/api/tests/db-schema.spec.ts apps/api/package.json
 git commit -m "feat(api): add postgres client and blindtest domain schema"
```

### Task 3: Integrate Better Auth with Elysia

**Files:**
- Create: `apps/api/src/auth/auth.ts`
- Create: `apps/api/src/auth/client.ts`
- Create: `apps/api/src/routes/account.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/tests/auth-better-auth.spec.ts`

**Step 1: Write the failing test**

```ts
// apps/api/tests/auth-better-auth.spec.ts
import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("better-auth integration", () => {
  it("exposes authenticated me endpoint", async () => {
    const response = await app.handle(new Request("http://localhost/account/me"));
    expect(response.status).toBe(401);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/auth-better-auth.spec.ts`  
Expected: FAIL (404 route missing).

**Step 3: Write minimal implementation**

```ts
// apps/api/src/auth/auth.ts
import { betterAuth } from "better-auth";
import { pool } from "../db/client";

export const auth = betterAuth({
  database: pool,
  emailAndPassword: { enabled: true },
});
```

```ts
// apps/api/src/routes/account.ts
import { Elysia } from "elysia";

export const accountRoutes = new Elysia({ prefix: "/account" }).get("/me", ({ set }) => {
  set.status = 401;
  return { ok: false, error: "UNAUTHORIZED" };
});
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/auth-better-auth.spec.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/auth apps/api/src/routes/account.ts apps/api/src/index.ts apps/api/tests/auth-better-auth.spec.ts
 git commit -m "feat(api): integrate better-auth baseline with account route"
```

### Task 4: Replace JSON Auth/History Stores with DB Repositories

**Files:**
- Create: `apps/api/src/repositories/MatchRepository.ts`
- Create: `apps/api/src/repositories/ProfileRepository.ts`
- Modify: `apps/api/src/routes/quiz.ts`
- Modify: `apps/api/src/routes/account.ts`
- Delete: `apps/api/src/services/AuthStore.ts`
- Delete: `apps/api/src/services/MatchHistoryStore.ts`
- Test: `apps/api/tests/match-repository.spec.ts`

**Step 1: Write the failing test**

```ts
// apps/api/tests/match-repository.spec.ts
import { describe, expect, it } from "vitest";
import { buildMatchInsertPayload } from "../src/repositories/MatchRepository";

describe("match repository", () => {
  it("maps room result payload to persistent record", () => {
    const payload = buildMatchInsertPayload({
      roomCode: "ROOM42",
      categoryQuery: "pop",
      ranking: [],
    });

    expect(payload.roomCode).toBe("ROOM42");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/match-repository.spec.ts`  
Expected: FAIL (missing repository file).

**Step 3: Write minimal implementation**

```ts
// apps/api/src/repositories/MatchRepository.ts
export function buildMatchInsertPayload(input: {
  roomCode: string;
  categoryQuery: string;
  ranking: unknown[];
}) {
  return {
    roomCode: input.roomCode,
    config: {
      categoryQuery: input.categoryQuery,
      rankingSize: input.ranking.length,
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/match-repository.spec.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/repositories apps/api/src/routes apps/api/tests/match-repository.spec.ts
 git rm apps/api/src/services/AuthStore.ts apps/api/src/services/MatchHistoryStore.ts
 git commit -m "refactor(api): replace json auth-history stores with db repositories"
```

### Task 5: Enforce Unified Participant Model (Host Can Play)

**Files:**
- Modify: `apps/api/src/services/RoomStore.ts`
- Modify: `apps/api/src/routes/quiz.ts`
- Test: `apps/api/tests/participants.spec.ts`

**Step 1: Write the failing test**

```ts
// apps/api/tests/participants.spec.ts
import { describe, expect, it } from "vitest";
import { RoomStore } from "../src/services/RoomStore";

describe("participants", () => {
  it("lets the creator join as regular participant", async () => {
    const store = new RoomStore();
    const { roomCode } = store.createRoom();
    const joined = store.joinRoom(roomCode, "HostPlayer");
    expect(joined?.ok).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/participants.spec.ts`  
Expected: FAIL until room metadata/permissions are aligned with unified participant model.

**Step 3: Write minimal implementation**

```ts
// Room metadata sketch
// owner is orchestrator only; every join is a participant entry
return {
  ok: true as const,
  playerId,
  playerCount: session.players.size,
  canControlMatch: playerId === session.ownerPlayerId,
};
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/participants.spec.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/RoomStore.ts apps/api/src/routes/quiz.ts apps/api/tests/participants.spec.ts
 git commit -m "feat(api): unify host and players under participant model"
```

### Task 6: Implement Deterministic Round Loop With Mixed Answer Modes

**Files:**
- Modify: `apps/api/src/services/RoomManager.ts`
- Modify: `apps/api/src/services/RoomStore.ts`
- Create: `apps/api/src/services/FuzzyMatcher.ts`
- Test: `apps/api/tests/round-loop.spec.ts`

**Step 1: Write the failing test**

```ts
// apps/api/tests/round-loop.spec.ts
import { describe, expect, it } from "vitest";
import { RoomManager } from "../src/services/RoomManager";

describe("round loop", () => {
  it("transitions through countdown -> playing -> reveal -> leaderboard", () => {
    const manager = new RoomManager("ROOM01");
    manager.startGame({ nowMs: 0, countdownMs: 3000, totalRounds: 1 });
    manager.tick({ nowMs: 3000, roundMs: 12000, revealMs: 4000 });
    expect(manager.state()).toBe("playing");
    manager.tick({ nowMs: 15000, roundMs: 12000, revealMs: 4000 });
    expect(manager.state()).toBe("reveal");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/round-loop.spec.ts`  
Expected: FAIL (leaderboard phase or mixed mode internals missing).

**Step 3: Write minimal implementation**

```ts
// RoomManager state includes leaderboard phase
type GameState =
  | "lobby"
  | "countdown"
  | "playing"
  | "reveal"
  | "leaderboard"
  | "results";
```

```ts
// FuzzyMatcher baseline
export function isTextAnswerCorrect(input: string, expected: string) {
  const a = input.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  return a.length > 1 && (a === b || b.includes(a));
}
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/round-loop.spec.ts apps/api/tests/score-calculator.spec.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/RoomManager.ts apps/api/src/services/RoomStore.ts apps/api/src/services/FuzzyMatcher.ts apps/api/tests/round-loop.spec.ts
 git commit -m "feat(api): add deterministic blindtest loop with mixed answer modes"
```

### Task 7: Add WebSocket Room Event Stream + Snapshot Resync

**Files:**
- Create: `apps/api/src/routes/realtime.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/room.ts`
- Test: `apps/api/tests/realtime-routes.spec.ts`

**Step 1: Write the failing test**

```ts
// apps/api/tests/realtime-routes.spec.ts
import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("realtime route contract", () => {
  it("exposes websocket upgrade endpoint", async () => {
    const response = await app.handle(new Request("http://localhost/realtime/room/ABCD12"));
    expect(response.status).not.toBe(404);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/realtime-routes.spec.ts`  
Expected: FAIL (route missing).

**Step 3: Write minimal implementation**

```ts
// apps/api/src/routes/realtime.ts
import { Elysia } from "elysia";

export const realtimeRoutes = new Elysia({ prefix: "/realtime" }).get(
  "/room/:roomCode",
  ({ params }) => ({ ok: true, roomCode: params.roomCode }),
);
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/realtime-routes.spec.ts apps/api/tests/room-routes.spec.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/routes/realtime.ts apps/api/src/index.ts apps/api/src/routes/room.ts apps/api/tests/realtime-routes.spec.ts
 git commit -m "feat(api): add room realtime stream endpoint and snapshot resync contract"
```

### Task 8: Rebuild Frontend IA and Visual System for Live Blindtest

**Files:**
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/routes/__root.tsx`
- Modify: `apps/web/src/styles.css`
- Create: `apps/web/src/routes/room/$roomCode/play.tsx`
- Create: `apps/web/src/routes/room/$roomCode/view.tsx`
- Test: `apps/web/src/routes/layout.spec.tsx`

**Step 1: Write the failing test**

```tsx
// apps/web/src/routes/layout.spec.tsx
import { describe, expect, it } from "vitest";
import { router } from "../router";

describe("router layout", () => {
  it("includes projection and player room routes", () => {
    const routeIds = router.routeTree.children?.map((route) => route.id) ?? [];
    expect(routeIds.join("|")).toContain("/room/$roomCode/play");
    expect(routeIds.join("|")).toContain("/room/$roomCode/view");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/routes/layout.spec.tsx`  
Expected: FAIL (routes missing).

**Step 3: Write minimal implementation**

```tsx
// router additions sketch
const roomPlayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/room/$roomCode/play",
  component: RoomPlayPage,
});

const roomViewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/room/$roomCode/view",
  component: RoomViewPage,
});
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/routes/layout.spec.tsx`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/router.tsx apps/web/src/routes/__root.tsx apps/web/src/styles.css apps/web/src/routes/room apps/web/src/routes/layout.spec.tsx
 git commit -m "feat(web): rebuild route architecture and modern live blindtest visual system"
```

### Task 9: Implement Live Gameplay UI (Mixed Modes + Realtime State)

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/realtime.ts`
- Modify: `apps/web/src/stores/gameStore.ts`
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/src/routes/room/$roomCode/view.tsx`
- Test: `apps/web/src/routes/live-gameplay.spec.tsx`

**Step 1: Write the failing test**

```tsx
// apps/web/src/routes/live-gameplay.spec.tsx
import { describe, expect, it } from "vitest";
import { createGameStore } from "../stores/gameStore";

describe("live gameplay store", () => {
  it("stores current phase and answer mode", () => {
    const store = createGameStore();
    store.getState().setLiveRound({ phase: "playing", mode: "mcq" });
    expect(store.getState().liveRound?.phase).toBe("playing");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/routes/live-gameplay.spec.tsx`  
Expected: FAIL (missing live round store action).

**Step 3: Write minimal implementation**

```ts
// gameStore live fragment
type LiveRoundState = {
  phase: "countdown" | "playing" | "reveal" | "leaderboard";
  mode: "mcq" | "text";
};

setLiveRound: (value: LiveRoundState | null) => set({ liveRound: value });
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/routes/live-gameplay.spec.tsx apps/web/src/routes/routes.spec.tsx`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/realtime.ts apps/web/src/stores/gameStore.ts apps/web/src/routes/room/$roomCode apps/web/src/routes/live-gameplay.spec.tsx
 git commit -m "feat(web): add realtime blindtest gameplay ui with mixed answer modes"
```

### Task 10: Quality Gates and End-to-End Blindtest Flow

**Files:**
- Modify: `apps/web/e2e/core-flow.spec.ts`
- Create: `apps/web/e2e/live-blindtest.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `.github/workflows/ci.yml`

**Step 1: Write the failing test**

```ts
// apps/web/e2e/live-blindtest.spec.ts
import { test, expect } from "@playwright/test";

test("host plays and scores in live blindtest", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Créer/i }).click();
  await expect(page).toHaveURL(/room\/.+\/play/);
});
```

**Step 2: Run test to verify it fails**

Run: `npx playwright test apps/web/e2e/live-blindtest.spec.ts`  
Expected: FAIL until new routes and flow are fully wired.

**Step 3: Write minimal implementation**

```yaml
# .github/workflows/ci.yml key jobs
- run: bun run lint
- run: bun run test
- run: npx playwright test
```

**Step 4: Run test to verify it passes**

Run:
- `bun run lint`
- `bun run test`
- `npx playwright test`

Expected: all PASS.

**Step 5: Commit**

```bash
git add apps/web/e2e playwright.config.ts .github/workflows/ci.yml
 git commit -m "test: add full blindtest live e2e and ci quality gates"
```

## Order and Checkpoints

1. Execute Tasks 1-3, then checkpoint review.
2. Execute Tasks 4-7, then checkpoint review.
3. Execute Tasks 8-10, then checkpoint review.
4. Stop immediately if Better Auth/Postgres integration assumptions are blocked by environment constraints.

Plan complete and saved to `docs/plans/2026-02-19-kahoot-inspired-blindtest-redesign-implementation-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
