# Kwizik Anime Mode + Source Modes Restructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the `Liked Songs` game mode end-to-end and ship a new `Anime` mode (AniList import + global autocomplete + synonym-aware validation + AnimeThemes reveal) while keeping public playlist mode stable.

**Architecture:** Replace `players_liked` with a first-class `anime` source mode in room state, host configuration APIs, and lobby UI. Build anime rounds from AniList user list data (statuses `CURRENT` + `COMPLETED`) and enrich rounds with anime metadata (canonical title + synonyms + reveal asset). Apply a dual playback contract on frontend: `anime` uses a single AnimeThemes `.webm` stream that starts during guess phase with video masked, then unmasked at reveal without restarting; general music mode keeps two relayed players (guess audio source, then cut/fadeover to YouTube reveal clip). Add a dedicated cached anime autocomplete pipeline backed by aggressive in-memory cache plus optional Redis persistence to handle 15k-20k entries.

**Tech Stack:** Bun, TypeScript, Elysia API, React 19 + TanStack Query + react-select, Vitest, Redis (optional), AniList GraphQL API, AnimeThemes.moe API.

---

## Skill References

- `@writing-plans` for this implementation plan structure
- `@executing-plans` for post-approval execution in batches
- `@supabase-postgres-best-practices` for cache/index/storage decisions when persisting catalog snapshots
- `@webapp-testing` for lobby + gameplay flow validation after implementation

---

## Playback UX Contract (Mandatory)

- **Anime mode (`single_masked_video`)**
  - Guess phase: play AnimeThemes `.webm` immediately, audio audible, image hidden by CSS mask/veil.
  - Reveal phase: do not restart or replace media; only remove mask so image appears while stream keeps current timestamp.
- **General mode (`audio_then_reveal_video`)**
  - Guess phase: play audio-only guessing source (preview/YTMusic equivalent).
  - Reveal phase: hard stop guessing audio, then mount/play YouTube reveal clip with YouTube audio taking over.
- **State ownership**
  - `gameStore.ts` (or equivalent room state) must expose enough state to drive the two strategies deterministically.
  - `play.tsx` and `view.tsx` must render player(s) according to strategy, not ad-hoc provider checks only.

---

### Task 1: Remove `Liked Songs` Mode Contract from Quiz APIs and Room State

**Files:**
- Modify: `apps/api/src/services/RoomStore.ts`
- Modify: `apps/api/src/routes/quiz.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/stores/gameStore.ts`
- Modify: `apps/web/src/routes/index.tsx`
- Test: `apps/api/tests/room-store.spec.ts`

**Step 1: Write failing tests for unsupported `players_liked`**

- Add/adjust tests to assert:
  - `setRoomSourceMode(..., "players_liked")` is rejected as invalid mode.
  - room snapshots never expose `sourceMode: "players_liked"`.
  - old lobby copy referencing Liked Songs is absent in rendered text snapshots (if covered).

**Step 2: Run tests to confirm failures**

Run: `bun test apps/api/tests/room-store.spec.ts -t "players_liked|source mode"`  
Expected: FAIL due to current accepted `players_liked` flow.

**Step 3: Implement minimal contract cleanup**

- Change source mode unions from `"public_playlist" | "players_liked"` to `"public_playlist" | "anime"`.
- Remove players-liked-only state branches (`poolBuild`, contributor checks, start-time sync waits) or gate them behind dead-code removal.
- Update `/quiz/source/mode` validation and payload typing.
- Update public-room summary and home-page mode labels to no longer mention Liked Songs.

**Step 4: Re-run focused tests**

Run: `bun test apps/api/tests/room-store.spec.ts -t "source mode|public playlist"`  
Expected: PASS for updated mode contract.

**Step 5: Commit**

```bash
git add apps/api/src/services/RoomStore.ts apps/api/src/routes/quiz.ts apps/web/src/lib/api.ts apps/web/src/stores/gameStore.ts apps/web/src/routes/index.tsx apps/api/tests/room-store.spec.ts
git commit -m "refactor(game-modes): remove players_liked contract and keep public playlist mode"
```

---

### Task 2: Add AniList Anime Source Input and Filtering (`CURRENT` + `COMPLETED`)

**Files:**
- Modify: `apps/api/src/routes/music/anilist.ts`
- Modify: `apps/api/src/routes/music/source.ts`
- Modify: `apps/api/src/services/TrackSourceResolver.ts`
- Modify: `apps/api/tests/track-source-resolver.spec.ts`
- Modify: `apps/api/tests/music-source-routes.spec.ts`
- Create: `apps/api/tests/anilist-route.spec.ts`

**Step 1: Write failing tests for AniList filtering and payload shape**

- Validate AniList query uses statuses `CURRENT` + `COMPLETED` only.
- Validate resolver accepts anime source query format for a single username (e.g. `anilist:user:<name>` or agreed final prefix).
- Validate AniList fetch returns canonical title + synonym array per anime entry (not title-only strings).

**Step 2: Run tests to confirm failures**

Run: `bun test apps/api/tests/track-source-resolver.spec.ts apps/api/tests/music-source-routes.spec.ts apps/api/tests/anilist-route.spec.ts`  
Expected: FAIL because current AniList layer returns only title strings and includes `REPEATING`.

**Step 3: Implement AniList source model**

- Change AniList GraphQL query to request:
  - `status_in: [CURRENT, COMPLETED]`
  - `media { id title { romaji english native } synonyms }`
- Introduce typed record (example: `AniListAnimeEntry`) with:
  - canonical title selection strategy (`romaji -> english -> native`)
  - normalized synonym set (deduped, trimmed, includes canonical).
- Keep support for existing route usage but return enriched records for anime-mode pipeline.

**Step 4: Re-run focused tests**

Run: `bun test apps/api/tests/track-source-resolver.spec.ts apps/api/tests/music-source-routes.spec.ts apps/api/tests/anilist-route.spec.ts`  
Expected: PASS with new filtering and data contract.

**Step 5: Commit**

```bash
git add apps/api/src/routes/music/anilist.ts apps/api/src/routes/music/source.ts apps/api/src/services/TrackSourceResolver.ts apps/api/tests/track-source-resolver.spec.ts apps/api/tests/music-source-routes.spec.ts apps/api/tests/anilist-route.spec.ts
git commit -m "feat(anime): enrich AniList import with CURRENT/COMPLETED and synonyms"
```

---

### Task 3: Build Anime Round Payloads (Canonical Answer + Synonyms Metadata)

**Files:**
- Modify: `apps/api/src/services/music-types.ts`
- Modify: `apps/api/src/services/TrackSourceResolver.ts`
- Modify: `apps/api/src/routes/music/anilist.ts`
- Modify: `apps/api/src/services/RoomStore.ts`
- Create: `apps/api/tests/anime-round-payload.spec.ts`

**Step 1: Write failing tests for answer metadata propagation**

- Assert anime-generated tracks carry answer metadata:
  - canonical anime name
  - alias/synonym list (including acronyms if provided by AniList)
- Assert RoomStore reveal `acceptedAnswer` is anime title, not `title - artist`.

**Step 2: Run tests to confirm failures**

Run: `bun test apps/api/tests/anime-round-payload.spec.ts`  
Expected: FAIL because current `MusicTrack` contract has no anime answer metadata.

**Step 3: Implement enriched track metadata**

- Extend track model with optional answer metadata block (example: `answer: { canonical: string; aliases: string[] }`).
- During AniList source resolution, map each selected anime to a playable track while preserving anime answer metadata on the resulting track.
- Ensure metadata survives cache/reuse flows used by RoomStore.

**Step 4: Re-run focused tests**

Run: `bun test apps/api/tests/anime-round-payload.spec.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/music-types.ts apps/api/src/services/TrackSourceResolver.ts apps/api/src/routes/music/anilist.ts apps/api/src/services/RoomStore.ts apps/api/tests/anime-round-payload.spec.ts
git commit -m "feat(anime): carry canonical title and synonym metadata through round tracks"
```

---

### Task 4: Implement Global Anime Autocomplete Cache (15k-20k Entries)

**Files:**
- Create: `apps/api/src/services/AnimeCatalogCache.ts`
- Modify: `apps/api/src/routes/music/search.ts`
- Modify: `apps/api/src/routes/quiz.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Create: `apps/api/tests/anime-catalog-cache.spec.ts`
- Create: `apps/api/tests/music-search-anime.spec.ts`

**Step 1: Write failing tests for global suggestions**

- API tests:
  - `GET /music/search?domain=anime&q=...` returns anime-title suggestions independent of room/user list.
  - repeated identical query uses cache (memory hit and optional Redis hit path).
- Front-end behavior tests (unit-level where possible):
  - text answer autocomplete calls global anime endpoint when source mode is anime.
  - does not depend on `state.answerSuggestions`.

**Step 2: Run tests to confirm failures**

Run: `bun test apps/api/tests/anime-catalog-cache.spec.ts apps/api/tests/music-search-anime.spec.ts`  
Expected: FAIL due to missing anime catalog cache/search mode.

**Step 3: Implement cache architecture**

- Introduce `AnimeCatalogCache` with:
  - in-memory primary cache (TTL + stale-while-revalidate)
  - optional Redis snapshot persistence (if configured) for warm restart
  - normalized index for prefix/includes matching
  - hard limits for response size and query minimum length.
- Extend `/music/search` to accept `domain=anime` and return compact suggestion payload.
- In `play.tsx`, when `sourceMode === "anime"`:
  - debounce user input
  - query global anime suggestions endpoint
  - merge/de-duplicate with local fallback only if endpoint fails.

**Step 4: Re-run focused tests**

Run: `bun test apps/api/tests/anime-catalog-cache.spec.ts apps/api/tests/music-search-anime.spec.ts`  
Expected: PASS with cache hit assertions.

**Step 5: Commit**

```bash
git add apps/api/src/services/AnimeCatalogCache.ts apps/api/src/routes/music/search.ts apps/api/src/routes/quiz.ts apps/web/src/lib/api.ts apps/web/src/routes/room/$roomCode/play.tsx apps/api/tests/anime-catalog-cache.spec.ts apps/api/tests/music-search-anime.spec.ts
git commit -m "feat(anime): add global cached anime autocomplete endpoint and lobby integration"
```

---

### Task 5: Validate Text Answers with `FuzzyMatcher` + `JapaneseRomanizer` + AniList Synonyms

**Files:**
- Modify: `apps/api/src/services/RoomStore.ts`
- Modify: `apps/api/src/services/FuzzyMatcher.ts`
- Modify: `apps/api/src/services/JapaneseRomanizer.ts`
- Modify: `apps/api/tests/room-store-romaji.spec.ts`
- Create: `apps/api/tests/anime-answer-validation.spec.ts`

**Step 1: Write failing tests for alias/acronym acceptance**

- Add cases for:
  - canonical title exact and fuzzy matches.
  - synonym acceptance (`AOT`, `FMAB`, `SAO`) via AniList synonyms.
  - romanized Japanese synonym acceptance.
- Add negative case where artist/song title alone is rejected in anime mode.

**Step 2: Run tests to confirm failures**

Run: `bun test apps/api/tests/anime-answer-validation.spec.ts apps/api/tests/room-store-romaji.spec.ts`  
Expected: FAIL because current variants include artist/title combos and no AniList synonym source.

**Step 3: Implement answer validation rules**

- In anime mode, compute answer candidates from:
  - canonical anime title
  - AniList synonyms/aliases
  - romanized variants of canonical + aliases.
- Keep existing fuzzy threshold behavior via `isTextAnswerCorrect`.
- Ensure non-anime modes keep existing behavior.

**Step 4: Re-run focused tests**

Run: `bun test apps/api/tests/anime-answer-validation.spec.ts apps/api/tests/room-store-romaji.spec.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/services/RoomStore.ts apps/api/src/services/FuzzyMatcher.ts apps/api/src/services/JapaneseRomanizer.ts apps/api/tests/anime-answer-validation.spec.ts apps/api/tests/room-store-romaji.spec.ts
git commit -m "feat(anime): validate answers against AniList synonyms and romanized aliases"
```

---

### Task 6: Add AnimeThemes Resolver + Front Playback Strategy Split

**Files:**
- Create: `apps/api/src/routes/music/animethemes.ts`
- Modify: `apps/api/src/services/TrackSourceResolver.ts`
- Modify: `apps/api/src/services/RoomStore.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/stores/gameStore.ts`
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/src/routes/room/$roomCode/view.tsx`
- Create: `apps/api/tests/animethemes-resolver.spec.ts`
- Create: `apps/web/src/routes/room/__tests__/anime-reveal-media.spec.tsx`
- Create: `apps/web/src/routes/room/__tests__/playback-strategy-switch.spec.tsx`

**Step 1: Write failing tests for playback strategies**

- API tests:
  - anime mode returns AnimeThemes media URL for guess+reveal continuity when available.
  - general mode reveal still resolves to YouTube clip URL.
- UI tests:
  - anime mode: guess phase renders masked `<video>`; reveal phase unmasks same player instance (same media key/timestamp continuity).
  - general mode: guess-phase audio element/player stops when reveal begins; YouTube iframe becomes the active media output.

**Step 2: Run tests to confirm failures**

Run: `bun test apps/api/tests/animethemes-resolver.spec.ts apps/web/src/routes/room/__tests__/anime-reveal-media.spec.tsx apps/web/src/routes/room/__tests__/playback-strategy-switch.spec.tsx`  
Expected: FAIL since current frontend playback logic is provider-driven and does not enforce the two explicit strategies.

**Step 3: Implement resolver + strategy state model**

- Add resolver client for AnimeThemes API with:
  - query by anime title and/or AniList ID when available
  - preference order: creditless + highest-quality `.webm`
  - cache layer (memory + optional Redis key per anime identifier).
- Store resolved AnimeThemes media on anime tracks with enough metadata to support continuous playback.
- In RoomStore snapshot generation, expose an explicit playback strategy field, e.g.:
  - `single_masked_video` for anime mode (shared media identity across playing/reveal)
  - `audio_then_reveal_video` for general mode.
- Front-end:
  - extend media/reveal unions to include `animethemes`
  - implement anime masked-video flow (CSS mask in playing, unmask in reveal, no source swap)
  - implement general-mode relay flow (stop guess audio before mounting/starting reveal YouTube player)
  - centralize strategy handling in store selectors/helpers instead of scattered provider checks.

**Step 4: Re-run focused tests**

Run: `bun test apps/api/tests/animethemes-resolver.spec.ts apps/web/src/routes/room/__tests__/anime-reveal-media.spec.tsx apps/web/src/routes/room/__tests__/playback-strategy-switch.spec.tsx`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/routes/music/animethemes.ts apps/api/src/services/TrackSourceResolver.ts apps/api/src/services/RoomStore.ts apps/web/src/lib/api.ts apps/web/src/stores/gameStore.ts apps/web/src/routes/room/$roomCode/play.tsx apps/web/src/routes/room/$roomCode/view.tsx apps/api/tests/animethemes-resolver.spec.ts apps/web/src/routes/room/__tests__/anime-reveal-media.spec.tsx apps/web/src/routes/room/__tests__/playback-strategy-switch.spec.tsx
git commit -m "feat(playback): split anime masked-video continuity and general reveal relay"
```

---

### Task 7: Lobby UX for Anime Mode + AniList Username Input

**Files:**
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/api/src/routes/quiz.ts`
- Create: `apps/web/src/routes/room/__tests__/anime-lobby-config.spec.tsx`

**Step 1: Write failing UI tests**

- Host can select `Anime` source mode.
- Host can input AniList username and save source configuration.
- Waiting-status messaging reflects anime pool preparation/errors.

**Step 2: Run tests to confirm failures**

Run: `bun test apps/web/src/routes/room/__tests__/anime-lobby-config.spec.tsx`  
Expected: FAIL due to missing anime source controls.

**Step 3: Implement lobby flow**

- Replace Liked Songs mode card with Anime mode card.
- Add AniList username field + submit action (host-only).
- Persist source as anime query format consumed by resolver.
- Update status/error copy for anime-specific startup failures.

**Step 4: Re-run focused tests**

Run: `bun test apps/web/src/routes/room/__tests__/anime-lobby-config.spec.tsx`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/routes/room/$roomCode/play.tsx apps/web/src/styles.css apps/web/src/lib/api.ts apps/api/src/routes/quiz.ts apps/web/src/routes/room/__tests__/anime-lobby-config.spec.tsx
git commit -m "feat(lobby): add anime source configuration and remove liked songs controls"
```

---

### Task 8: Full Regression, Cleanup, and Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: impacted tests and fixtures from previous tasks

**Step 1: Run targeted backend suite**

Run:

```bash
bun test apps/api/tests/track-source-resolver.spec.ts
bun test apps/api/tests/music-source-routes.spec.ts
bun test apps/api/tests/room-store.spec.ts
bun test apps/api/tests/anime-answer-validation.spec.ts
bun test apps/api/tests/animethemes-resolver.spec.ts
```

Expected: PASS.

**Step 2: Run targeted frontend suite**

Run:

```bash
bun test apps/web/src/routes/room/__tests__/anime-lobby-config.spec.tsx
bun test apps/web/src/routes/room/__tests__/anime-reveal-media.spec.tsx
bun test apps/web/src/routes/room/__tests__/playback-strategy-switch.spec.tsx
```

Expected: PASS.

**Step 3: Run end-to-end sanity checks**

Run:

```bash
bun run test:e2e
```

Expected: PASS for room creation, mode switch, gameplay, reveal.

**Step 4: Update docs**

- README: replace Liked Songs wording with Public Playlist + Anime mode.
- Mention AniList username requirement and anime autocomplete behavior.
- Document the two playback UX strategies explicitly:
  - anime continuous masked/unmasked video
  - general audio-to-YouTube reveal relay.

**Step 5: Final commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document anime mode rollout and source-mode restructuring"
```

---

## Rollout Notes

- Keep a short-lived compatibility parser for legacy source values (`players:liked`) to avoid crashing old clients; map them to a safe default (`public_playlist`) with a warning log.
- Feature-flag AnimeThemes reveal fallback: if AnimeThemes resolution fails, reveal should still show textual answer and continue round flow.
- Cache guardrails:
  - cap suggestion payload size per request
  - enforce query minimum length
  - throttle refresh of full anime catalog snapshot.

---

## Execution Batch Proposal (`@executing-plans`)

- **Batch 1:** Tasks 1-2 (mode contract cleanup + AniList filtering/data model)
- **Batch 2:** Tasks 3-4 (anime metadata propagation + global cached autocomplete)
- **Batch 3:** Tasks 5-6 (synonym/romanized validation + AnimeThemes reveal)
- **Batch 4:** Tasks 7-8 (frontend lobby polish + full regression + docs)

Stop after each batch, report test output, and wait for review before continuing.
