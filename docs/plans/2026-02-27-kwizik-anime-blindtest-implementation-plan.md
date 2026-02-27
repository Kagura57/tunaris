# Kwizik Anime-Only Blind Test Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace legacy music-provider gameplay with an anime-only blind test flow powered by AniList account sync and AnimeThemes `.webm` media.

**Architecture:** Introduce a dedicated anime data domain (catalog, aliases, theme videos, user libraries, sync runs), keep sync user-triggered and async with staging + atomic swap, and route gameplay + autocomplete through anime-only sources. Frontend keeps one continuous `<video>` per round, fully hidden during guessing and revealed without restart.

**Tech Stack:** Bun, TypeScript, Elysia API, PostgreSQL, Better Auth, BullMQ/Redis, React/Vite, TanStack Query, Vitest, Playwright.

---

### Task 1: Add Anime Domain Tables and Indexes

**Files:**
- Modify: `apps/api/src/db/schema.sql`
- Test: `apps/api/tests/db-schema-anime-pivot.spec.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("anime pivot schema", () => {
  it("defines anime catalog, user library, and sync tables", () => {
    const sql = readFileSync("apps/api/src/db/schema.sql", "utf8");

    expect(sql).toContain("create table if not exists anime_catalog_anime");
    expect(sql).toContain("create table if not exists anime_catalog_alias");
    expect(sql).toContain("create table if not exists anime_theme_videos");
    expect(sql).toContain("create table if not exists anilist_account_links");
    expect(sql).toContain("create table if not exists anilist_sync_runs");
    expect(sql).toContain("create table if not exists anilist_sync_staging");
    expect(sql).toContain("create table if not exists user_anime_library_active");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/db-schema-anime-pivot.spec.ts`
Expected: FAIL with missing table definitions.

**Step 3: Write minimal implementation**

```sql
create table if not exists anime_catalog_anime (
  id bigserial primary key,
  animethemes_anime_id text not null unique,
  title_romaji text not null,
  title_english text,
  title_native text,
  searchable_romaji text not null,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists anime_catalog_alias (
  id bigserial primary key,
  anime_id bigint not null references anime_catalog_anime(id) on delete cascade,
  alias text not null,
  normalized_alias text not null,
  alias_type text not null check (alias_type in ('canonical', 'synonym', 'acronym')),
  unique (anime_id, normalized_alias)
);

create table if not exists anime_theme_videos (
  id bigserial primary key,
  anime_id bigint not null references anime_catalog_anime(id) on delete cascade,
  theme_type text not null check (theme_type in ('OP', 'ED')),
  theme_number integer,
  video_key text not null unique,
  webm_url text not null,
  resolution integer,
  is_creditless boolean not null default false,
  is_playable boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists anilist_account_links (
  user_id text primary key references "user"(id) on delete cascade,
  anilist_user_id text,
  anilist_username text,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  scope text,
  updated_at timestamptz not null default now()
);

create table if not exists anilist_sync_runs (
  id bigserial primary key,
  user_id text not null references "user"(id) on delete cascade,
  status text not null check (status in ('queued', 'running', 'success', 'error')),
  progress integer not null default 0,
  message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists anilist_sync_staging (
  run_id bigint not null references anilist_sync_runs(id) on delete cascade,
  user_id text not null references "user"(id) on delete cascade,
  anime_id bigint not null references anime_catalog_anime(id) on delete cascade,
  list_status text not null check (list_status in ('WATCHING', 'COMPLETED')),
  primary key (run_id, anime_id)
);

create table if not exists user_anime_library_active (
  user_id text not null references "user"(id) on delete cascade,
  anime_id bigint not null references anime_catalog_anime(id) on delete cascade,
  list_status text not null check (list_status in ('WATCHING', 'COMPLETED')),
  synced_at timestamptz not null default now(),
  primary key (user_id, anime_id)
);

create index if not exists idx_anime_alias_normalized on anime_catalog_alias(normalized_alias);
create index if not exists idx_anime_theme_playable on anime_theme_videos(is_playable, theme_type);
create index if not exists idx_user_anime_library_user on user_anime_library_active(user_id);
create index if not exists idx_anilist_sync_runs_user_created on anilist_sync_runs(user_id, created_at desc);
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/db-schema-anime-pivot.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/db/schema.sql apps/api/tests/db-schema-anime-pivot.spec.ts
git commit -m "feat: add anime pivot schema tables and indexes"
```

### Task 2: Add AniList OAuth Link Service and Endpoints

**Files:**
- Create: `apps/api/src/services/AniListOAuthService.ts`
- Modify: `apps/api/src/routes/account.ts`
- Test: `apps/api/tests/anilist-oauth.spec.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildAniListConnectUrl } from "../src/services/AniListOAuthService";

describe("anilist oauth", () => {
  it("builds authorize url with state", () => {
    const result = buildAniListConnectUrl({ userId: "u_1", returnTo: "/settings" });
    expect(result?.url).toContain("https://anilist.co/api/v2/oauth/authorize");
    expect(result?.url).toContain("state=");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/anilist-oauth.spec.ts`
Expected: FAIL with missing service/export.

**Step 3: Write minimal implementation**

```ts
export function buildAniListConnectUrl(input: { userId: string; returnTo?: string | null }) {
  const clientId = process.env.ANILIST_CLIENT_ID?.trim() ?? "";
  const redirectUri = process.env.ANILIST_REDIRECT_URI?.trim() ?? "";
  if (!clientId || !redirectUri) return null;

  const state = Buffer.from(JSON.stringify({ u: input.userId, r: input.returnTo ?? null })).toString("base64url");
  const url = new URL("https://anilist.co/api/v2/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/anilist-oauth.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/AniListOAuthService.ts apps/api/src/routes/account.ts apps/api/tests/anilist-oauth.spec.ts
git commit -m "feat: add anilist oauth connect flow"
```

### Task 3: Implement AniList Sync Repositories with Atomic Swap

**Files:**
- Create: `apps/api/src/repositories/AniListSyncRunRepository.ts`
- Create: `apps/api/src/repositories/UserAnimeLibraryRepository.ts`
- Test: `apps/api/tests/anilist-sync-repository.spec.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { userAnimeLibraryRepository } from "../src/repositories/UserAnimeLibraryRepository";

describe("user anime library repository", () => {
  it("replaces active rows using staged run atomically", async () => {
    await userAnimeLibraryRepository.replaceFromStaging({ runId: 42, userId: "u_1" });
    const rows = await userAnimeLibraryRepository.listByUser("u_1", 10);
    expect(Array.isArray(rows)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/anilist-sync-repository.spec.ts`
Expected: FAIL with missing repository methods.

**Step 3: Write minimal implementation**

```ts
async replaceFromStaging(input: { runId: number; userId: string }) {
  await pool.query("begin");
  try {
    await pool.query("delete from user_anime_library_active where user_id = $1", [input.userId]);
    await pool.query(
      `insert into user_anime_library_active (user_id, anime_id, list_status, synced_at)
       select user_id, anime_id, list_status, now()
       from anilist_sync_staging
       where run_id = $1 and user_id = $2`,
      [input.runId, input.userId],
    );
    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback");
    throw error;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/anilist-sync-repository.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/repositories/AniListSyncRunRepository.ts apps/api/src/repositories/UserAnimeLibraryRepository.ts apps/api/tests/anilist-sync-repository.spec.ts
git commit -m "feat: add anilist sync repositories with atomic library swap"
```

### Task 4: Add Async Manual Sync Queue + Worker

**Files:**
- Create: `apps/api/src/services/jobs/anilist-sync-queue.ts`
- Create: `apps/api/src/services/jobs/anilist-sync-worker.ts`
- Create: `apps/api/src/services/jobs/anilist-sync-trigger.ts`
- Modify: `apps/api/src/routes/account.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/tests/anilist-sync-queue.spec.ts`
- Test: `apps/api/tests/anilist-sync-worker.spec.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildAniListSyncJobId } from "../src/services/jobs/anilist-sync-queue";

describe("anilist sync queue", () => {
  it("builds deterministic job id", () => {
    expect(buildAniListSyncJobId("user:42")).toBe("anilist-sync-user_42");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/anilist-sync-queue.spec.ts`
Expected: FAIL with missing module/export.

**Step 3: Write minimal implementation**

```ts
export function buildAniListSyncJobId(userId: string) {
  const safe = userId.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return `anilist-sync-${safe || "unknown"}`;
}

export async function enqueueAniListSyncJob(userId: string) {
  const queue = getAniListSyncQueue();
  if (!queue) return null;
  return queue.add("sync-user-anilist", { userId: userId.trim() }, { jobId: buildAniListSyncJobId(userId) });
}
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/anilist-sync-queue.spec.ts apps/api/tests/anilist-sync-worker.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/jobs/anilist-sync-queue.ts apps/api/src/services/jobs/anilist-sync-worker.ts apps/api/src/services/jobs/anilist-sync-trigger.ts apps/api/src/routes/account.ts apps/api/src/index.ts apps/api/tests/anilist-sync-queue.spec.ts apps/api/tests/anilist-sync-worker.spec.ts
git commit -m "feat: add async anilist manual sync queue and worker"
```

### Task 5: Build Daily AnimeThemes Catalog Mirror Job

**Files:**
- Create: `apps/api/src/services/AnimeThemesCatalogService.ts`
- Create: `apps/api/src/services/jobs/animethemes-catalog-refresh.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/tests/animethemes-catalog-refresh.spec.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { normalizeAnimeAlias } from "../src/services/AnimeThemesCatalogService";

describe("animethemes catalog", () => {
  it("normalizes aliases for search", () => {
    expect(normalizeAnimeAlias("Shingeki no Kyojin!")).toBe("shingeki no kyojin");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/animethemes-catalog-refresh.spec.ts`
Expected: FAIL with missing service/export.

**Step 3: Write minimal implementation**

```ts
export function normalizeAnimeAlias(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function refreshAnimeThemesCatalog() {
  // Fetch AnimeThemes API pages, upsert anime_catalog_anime, anime_catalog_alias, anime_theme_videos.
}
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/animethemes-catalog-refresh.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/AnimeThemesCatalogService.ts apps/api/src/services/jobs/animethemes-catalog-refresh.ts apps/api/src/index.ts apps/api/tests/animethemes-catalog-refresh.spec.ts
git commit -m "feat: add daily animethemes catalog mirror refresh"
```

### Task 6: Add Anime Name Autocomplete API (Global)

**Files:**
- Create: `apps/api/src/services/AnimeAutocomplete.ts`
- Create: `apps/api/src/routes/anime/autocomplete.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/tests/anime-autocomplete.spec.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { rankAnimeSuggestions } from "../src/services/AnimeAutocomplete";

describe("anime autocomplete", () => {
  it("ranks exact and acronym matches before fuzzy", () => {
    const ranked = rankAnimeSuggestions(
      [
        { canonical: "Attack on Titan", alias: "aot", score: 0 },
        { canonical: "Attack on Titan", alias: "attack on titan", score: 0 },
      ],
      "aot",
    );

    expect(ranked[0]?.canonical).toBe("Attack on Titan");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/anime-autocomplete.spec.ts`
Expected: FAIL with missing module/export.

**Step 3: Write minimal implementation**

```ts
export function rankAnimeSuggestions(rows: SuggestionRow[], query: string) {
  const q = normalize(query);
  return rows
    .map((row) => {
      const alias = normalize(row.alias);
      const canonical = normalize(row.canonical);
      const rank = alias === q ? 0 : canonical === q ? 1 : alias.startsWith(q) ? 2 : alias.includes(q) ? 3 : 4;
      return { ...row, score: rank };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 12);
}
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/anime-autocomplete.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/AnimeAutocomplete.ts apps/api/src/routes/anime/autocomplete.ts apps/api/src/index.ts apps/api/tests/anime-autocomplete.spec.ts
git commit -m "feat: add global anime name autocomplete api"
```

### Task 7: Pivot Room Source and Answer Validation to Anime-Only

**Files:**
- Modify: `apps/api/src/services/RoomStore.ts`
- Modify: `apps/api/src/services/TrackSourceResolver.ts`
- Modify: `apps/api/src/routes/quiz.ts`
- Modify: `apps/api/src/services/music-types.ts`
- Test: `apps/api/tests/room-anime-mode.spec.ts`
- Test: `apps/api/tests/answer-anime-alias.spec.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { isTextAnswerCorrect } from "../src/services/FuzzyMatcher";

describe("anime answer acceptance", () => {
  it("accepts acronym aliases", () => {
    expect(isTextAnswerCorrect("AOT", "Attack on Titan")).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/api/tests/answer-anime-alias.spec.ts apps/api/tests/room-anime-mode.spec.ts`
Expected: FAIL with old source modes / old answer semantics.

**Step 3: Write minimal implementation**

```ts
export type RoomSourceMode = "anilist_union";
export type ThemeMode = "op_only" | "ed_only" | "mix";

// Room start now resolves playable rounds from user_anime_library_active + anime_theme_videos.
// Accepted answers now use canonical + alias map from anime_catalog_alias.
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/api/tests/answer-anime-alias.spec.ts apps/api/tests/room-anime-mode.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/RoomStore.ts apps/api/src/services/TrackSourceResolver.ts apps/api/src/routes/quiz.ts apps/api/src/services/music-types.ts apps/api/tests/room-anime-mode.spec.ts apps/api/tests/answer-anime-alias.spec.ts
git commit -m "feat: pivot room generation and answers to anime-only"
```

### Task 8: Update Frontend Room UX, Autocomplete, and Video Reveal Behavior

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/routes/live-gameplay.spec.tsx`
- Test: `apps/web/src/routes/room-play-anime.spec.tsx`

**Step 1: Write the failing test**

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoomPlayPage } from "../src/routes/room/$roomCode/play";

describe("room play anime mode", () => {
  it("shows anime answer placeholder", () => {
    render(<RoomPlayPage />);
    expect(screen.getByText(/nom de l'anime/i)).toBeTruthy();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/routes/room-play-anime.spec.tsx`
Expected: FAIL with old wording / old source controls.

**Step 3: Write minimal implementation**

```tsx
// @vercel-react-best-practices: keep memoized suggestion list and debounced query key.
<Select
  placeholder="Nom de l'anime"
  options={animeNameOptions}
  onInputChange={setAnimeAnswerInput}
/>

<video
  ref={videoRef}
  className={state?.state === "playing" ? "anime-video-hidden" : "anime-video-reveal"}
  src={state?.media?.sourceUrl ?? undefined}
  autoPlay
  playsInline
/>
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/routes/live-gameplay.spec.tsx apps/web/src/routes/room-play-anime.spec.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/routes/room/$roomCode/play.tsx apps/web/src/styles.css apps/web/src/routes/live-gameplay.spec.tsx apps/web/src/routes/room-play-anime.spec.tsx
git commit -m "feat: update room ui for anime autocomplete and hidden video reveal"
```

### Task 9: End-to-End and Cleanup of Legacy Provider Surface

**Files:**
- Modify: `apps/api/src/index.ts`
- Modify: `README.md`
- Modify: `apps/web/e2e/live-blindtest.spec.ts`
- Modify: `apps/web/e2e/core-flow.spec.ts`

**Step 1: Write the failing test**

```ts
import { test, expect } from "@playwright/test";

test("anime round keeps video hidden during guessing then reveals without restart", async ({ page }) => {
  await page.goto("/room/demo/play");
  await expect(page.locator(".anime-video-hidden")).toBeVisible();
});
```

**Step 2: Run test to verify it fails**

Run: `bun run test:e2e -- --grep "anime round keeps video hidden"`
Expected: FAIL with missing selector/behavior.

**Step 3: Write minimal implementation**

```ts
// Remove legacy provider routes from app wiring.
// Keep /account/anilist/* and /anime/autocomplete as public game dependencies.
```

**Step 4: Run tests to verify it passes**

Run: `bun test apps/api/tests apps/web/src/routes packages/shared/src`
Expected: PASS.

Run: `bun run test:e2e`
Expected: PASS for core anime flow.

**Step 5: Commit**

```bash
git add apps/api/src/index.ts README.md apps/web/e2e/live-blindtest.spec.ts apps/web/e2e/core-flow.spec.ts
git commit -m "chore: remove legacy provider surface and finalize anime-only flow"
```

---

### Global Verification Checklist

Run after Task 9:
- `bun run lint`
- `bun test apps/api/tests packages/shared/src apps/web/src/routes`
- `bun run test:e2e:list`

Expected:
- Lint clean.
- Unit/integration tests green.
- E2E list includes anime-only scenario coverage.

---

### Notes for Implementer

- Keep every DB write path idempotent.
- Do not expose partial library data during sync failures.
- Do not add non-AnimeThemes media fallback.
- Preserve strict no-video-visibility during guessing.
- Prefer small commits exactly as listed.

