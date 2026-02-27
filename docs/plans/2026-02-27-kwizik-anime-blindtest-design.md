# Kwizik Anime-Only Blind Test Design

**Date:** 2026-02-27
**Status:** Approved
**Scope:** Full pivot from multi-provider music quiz to anime-only blind test using AniList + AnimeThemes.

---

## 1. Product Direction

Kwizik pivots to an **anime-only blind test game** inspired by AMQ.

Fixed foundations:
- Media source is exclusively **AnimeThemes.moe** (`.webm`).
- User data source is **AniList account linking** with private profile support.
- Quiz answer is the **anime name** (not artist/song title).
- Global autocomplete must support canon titles, synonyms, and acronyms.

Out of scope after pivot:
- Spotify, YouTube, Deezer, Apple Music, Tidal gameplay sources.
- Any non-anime generic music mode.

---

## 2. Final Decisions (Validated)

- Sync model: **manual refresh by user** (AMQ-like), no webhook dependency.
- Sync write strategy: **full replacement** of AniList-backed user library.
- Sync execution: **asynchronous background job**.
- Consistency model: **staging + atomic swap** (never expose partial library state).
- Catalog scope for autocomplete: **only animes with playable AnimeThemes media**.
- Video behavior: **strict continuity** from guessing phase to reveal (no restart).
- Guessing phase visibility: **video must be 100% hidden**.
- Guessing phase UX: optional **abstract visualizer** allowed.
- Answer acceptance: canonical + synonyms + acronyms + light typo tolerance.
- Multiplayer pool source: **union of linked players' AniList libraries**.
- Theme type selection: host chooses room-global mode **OP only / ED only / Mix**.
- Reveal canonical label: **Romaji priority** (English/Native accepted as aliases).
- AniList privacy: **private profile support via OAuth tokens (encrypted at rest)**.
- AnimeThemes dataset: **local Postgres mirror**, refreshed by **daily cron**.
- Unplayable entries: excluded from pool with no external fallback.
- User library history depth: **current state only** (no full snapshots).

---

## 3. Architecture

### 3.1 Domain Data Model

Target data domains:
- **Account Linking**
  - AniList OAuth link per user (encrypted access/refresh tokens, expiry, scopes).
- **Anime Catalog Mirror** (from AnimeThemes)
  - Canonical anime metadata (romaji/english/native).
  - Alias table for synonyms and acronyms, normalized for search.
  - Theme/video table: OP/ED metadata, versioning flags, playable `.webm` URL.
- **User Anime Library (Active)**
  - Current AniList-derived anime set for each user.
  - Status limited to user-approved gameplay statuses: `WATCHING`, `COMPLETED`.
- **Sync Orchestration**
  - Sync runs table for async job tracking (queued/running/success/error/progress/error_message).
  - Sync staging table used per run before final atomic activation.

### 3.2 Sync Pipeline (Manual, Async, Atomic)

Trigger:
- User explicitly clicks refresh in account/settings UX.

Execution flow:
1. Create sync run (`queued` -> `running`).
2. Fetch AniList list using user OAuth token.
3. Normalize and write rows to staging for this run.
4. Validate staged set (dedupe, catalog joinability checks).
5. Atomic transaction:
   - Replace active user library with staged dataset.
   - Mark sync run `success` and completion timestamp.
6. On failure:
   - Keep previous active library untouched.
   - Mark sync run `error` with message.

Properties:
- No partial active-state exposure.
- Deterministic full replacement semantics.
- Easy retry from UI.

### 3.3 Catalog Refresh Pipeline (Daily)

A scheduled daily job:
- Pulls AnimeThemes catalog data.
- Upserts anime canonical metadata, aliases, theme/video records.
- Recomputes playability flags.
- Keeps search corpus aligned to playable inventory.

---

## 4. Gameplay Flow

### 4.1 Room Pool Generation

On game start:
- Build candidate anime set from **union of linked players' active libraries**.
- Filter by host mode:
  - `OP_ONLY`
  - `ED_ONLY`
  - `MIX`
- Keep only playable theme-video rows.
- Sample per round using fairness/randomization constraints.

### 4.2 Reveal Answer Semantics

- Stored canonical answer is anime romaji label.
- Accepted variants include:
  - Canonical romaji.
  - Known English/native synonyms.
  - Known acronyms (e.g., AOT, SAO).
  - Light typo tolerance via normalized fuzzy matching.

---

## 5. Frontend Media Playback Design

Core rule: **one video element per round**.

Behavior:
- During `playing`:
  - `.webm` starts and keeps running.
  - Video rendering is fully hidden (no visible frame leak).
  - Audio is audible.
  - UI can display abstract visualizer.
- During `reveal`:
  - Same element becomes visible.
  - No `src` reset and no seek-to-zero.
  - Continuity is preserved (no cut/glitch from reinitialization).

Failure handling:
- If media cannot play, mark round as media failure and skip cleanly.
- Never fallback to external non-AnimeThemes source.

---

## 6. Global Anime Autocomplete Strategy

Architecture choice: **server-side search on Postgres indexed corpus**.

Data source:
- Only playable AnimeThemes-backed catalog entries.

Query behavior:
- Input is anime-name oriented.
- Ranking priority:
  1. Exact alias/canonical match
  2. Acronym match
  3. Prefix match
  4. Contains/fuzzy match
- Debounced requests from client.
- Small bounded response payload (top-N only).

Performance controls:
- Normalized search columns and dedicated indexes.
- Short TTL cache for hot prefixes.
- No large full-catalog transfer to browser.

---

## 7. Reliability and Observability

Track:
- Sync run lifecycle durations and failure rates.
- Count of excluded unplayable library entries.
- Room start failures due to insufficient playable pool.
- Media playback startup and round-skip reasons.
- Autocomplete latency and cache hit rate.

User-facing states:
- Last successful sync timestamp.
- Current sync status/progress.
- Clear error message on sync failure with retry path.

---

## 8. Testing Strategy

### Unit
- Alias normalization and acronym matching.
- Fuzzy acceptance thresholds for anime-name answers.
- Pool filters by OP/ED/Mix modes.

### Integration
- AniList manual sync job state transitions.
- Staging-to-active atomic swap behavior.
- Full replacement semantics after list changes.

### End-to-End
- Guessing phase shows no video frame.
- Reveal shows continuous video without restart.
- Multiplayer union-library round generation correctness.
- Anime-name autocomplete quality and response time envelope.

---

## 9. Migration Intent

This design intentionally replaces legacy music-provider-centric gameplay assumptions.
Existing Spotify/YouTube/Deezer game flows are considered migration/deprecation targets in implementation.

