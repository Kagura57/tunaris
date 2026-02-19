Original prompt: Reprendre le handoff et transformer Tunaris en vraie app web blindtest moderne (inspiration Kahoot), avec backend plus pro, Better Auth, et sans distinction host/joueur.

## 2026-02-19 - Progression

- Migrated auth routing to Better Auth (`/auth/*`) and added `/account/me` + `/account/history`.
- Removed JSON auth/history services and replaced them with repositories (`MatchRepository`, `ProfileRepository`) with Postgres + memory fallback.
- Upgraded round engine to support `leaderboard` phase and mixed modes (`mcq` + `text`).
- Added fuzzy answer matcher and realtime snapshot endpoint (`/realtime/room/:roomCode`).
- Rebuilt frontend routes around:
  - `/room/$roomCode/play` (player console)
  - `/room/$roomCode/view` (projection view)
- Reworked global design system and responsive layout for a more production-like blindtest UI.
- Updated unit tests and added e2e specs for core blindtest flows.
- Added production hardening:
  - structured JSON logging (`apps/api/src/lib/logger.ts`)
  - retry/backoff on provider HTTP calls (`apps/api/src/routes/music/http.ts`)
  - provider context/error logging and partial outage logging (`apps/api/src/services/MusicAggregator.ts`)
  - stale-cache fallback logging (`apps/api/src/services/TrackCache.ts`)
  - audio coverage logging at room start (`apps/api/src/services/RoomStore.ts`)
  - frontend GET retry/backoff (`apps/web/src/lib/api.ts`)
  - realtime fallback + audio error client logging (`apps/web/src/lib/realtime.ts`, `apps/web/src/routes/room/$roomCode/play.tsx`)
- Added observability advanced:
  - request-id propagation and response echo (`x-request-id`) across API requests
  - correlated frontend request ids on every API call
  - provider latency/health counters in memory (`apps/api/src/lib/provider-metrics.ts`)
  - new `/health/details` endpoint with uptime + room/cache/provider snapshots
  - API request completion logs now include request id, method, path, status, duration
- Added music source integrations for production blindtest pools:
  - Spotify auth manager with client-credentials fallback (`apps/api/src/routes/music/spotify-auth.ts`)
  - Spotify popular + playlist tracks (`apps/api/src/routes/music/spotify.ts`)
  - Deezer chart + playlist tracks (`apps/api/src/routes/music/deezer.ts`)
  - AniList user anime list ingestion + opening theme pool builder (`apps/api/src/routes/music/anilist.ts`)
  - Source parser/resolver (`apps/api/src/services/TrackSourceResolver.ts`)
  - Source preview endpoints:
    - `GET /music/source/resolve?source=...&size=...`
    - `GET /music/anilist/titles?users=userA,userB`
  - Front home screen now supports source presets and emits proper source queries.

### Source query formats accepted

- `popular hits` (free search fallback)
- `spotify:popular`
- `spotify:playlist:<playlist_id>`
- `deezer:chart`
- `deezer:playlist:<playlist_id>`
- `anilist:users:userA,userB,userC`

### No-mock policy (enforced)

- Mock tracks generation removed from backend.
- If no real tracks are found from providers, `/quiz/start` now returns:
  - `422` + `{ ok: false, error: "NO_TRACKS_FOUND" }`
- UI now surfaces a clear message when this happens.

## Remaining checks

- [x] Execute Playwright e2e suite and fix any UI flow regressions.
- [ ] Validate final end-to-end behavior manually in browser if needed (room create/join/start, mcq/text, leaderboard, results).

## 2026-02-19 - Audio + Reveal pass

- Added `sourceUrl` propagation across all music providers and exposed richer media metadata in room snapshots:
  - `media` (current phase): provider, trackId, sourceUrl, embedUrl
  - `reveal`: now includes `trackId`, `provider`, `previewUrl`, `sourceUrl`, `embedUrl`
- Fixed silent reveal issue by keeping `previewUrl` available during `reveal`/`leaderboard`/`results` (not only `playing`).
- Added embed URL generation for reveal/fallback media:
  - Spotify embed track iframe
  - YouTube/YTMusic embed video iframe
  - Deezer widget fallback
- Improved source resolution and aggregation to prioritize tracks that include audio previews:
  - `TrackSourceResolver`: preview-first ordering before slicing.
  - `MusicAggregator`: fallback now prioritizes tracks with previews across providers.
  - `Spotify playlist`: fetches a larger window (up to 100), dedupes, then preview-first selects.
- Frontend play/view now:
  - auto-attempt audio playback when preview updates,
  - display autoplay-blocked feedback,
  - display reveal clip iframe and source link when available,
  - use provider embed fallback when no direct preview URL exists.
- Added regression coverage:
  - `room-store.spec.ts`: verifies preview/media continuity from playing to reveal.
  - `music-aggregator.spec.ts`: verifies preview prioritization in fallback selection.

## 2026-02-19 - Blindtest UX hard reset

- Reworked game shell behavior:
  - No global topbar/nav/reset while on `/room/$roomCode/play` or `/room/$roomCode/view`.
  - Session is cleared when leaving room routes, forcing a fresh join with room code.
- Rebuilt player screen to focus on blindtest gameplay:
  - Fullscreen stage UI.
  - Hidden audio element (no visible Spotify player / metadata during rounds).
  - Animated waveform + timeline progress bar instead of exposing platform player controls.
  - Projection CTA shown only in waiting state (before match starts).
  - Added explicit `Quitter` action that clears session.
- Rebuilt projection screen in the same fullscreen stage style with hidden audio and reveal-only answer display.
- Added public rooms listing:
  - Backend endpoint `GET /quiz/public`.
  - Home and Join pages now show active public rooms and quick-join flows.
- Spotify source UX upgrade:
  - Added `GET /music/spotify/categories` (curated presets).
  - Added `GET /music/spotify/playlists` with modes:
    - popular playlists
    - playlists by category
    - free search query
  - Home page now supports dynamic Spotify playlist selection (popular/category/manual) instead of a single fixed ID.
- Gameplay audio reliability:
  - `RoomStore.startGame` now keeps only tracks with non-empty `previewUrl`.
  - If no playable preview tracks remain, game start fails with `NO_TRACKS_FOUND`.

## 2026-02-19 - Follow-up Spotify + DA alignment

- Added a minimal room top bar with logo + home link on room routes (`/room/*`) to keep navigation consistent with the original DA.
- Re-aligned in-game fullscreen palette with the main app style (less purple-heavy, same visual direction as home).
- Added Spotify preview enrichment fallback via iTunes Search preview matching:
  - keeps Spotify as source playlist selection,
  - attempts to fill missing `previewUrl` for Spotify tracks when Spotify returns null previews,
  - caches preview lookups for performance.
- Increased source fetch window at game start (up to 50 tracks requested) before preview-only filtering to improve playable hit rate.

### New blindtest direction

- During rounds: no track title/artist exposure.
- End of round: reveal only.
- Playlist selection is surfaced before starting the room, not during active gameplay.

## Test runs

- `bun run test`: PASS
- `bun run lint`: PASS
- `npx playwright test`: PASS (2 specs)
- `bun run test`: PASS (42 tests)
- `bun run lint`: PASS
- `npx playwright test`: PASS (2 specs)
- `bun run lint`: PASS
- `bun run test`: PASS (45 tests)
- `npx playwright test`: PASS (2 specs)

## 2026-02-19 - Spotify token + source robustness follow-up

- Fixed Spotify token priority to prevent stale `SPOTIFY_ACCESS_TOKEN` from blocking valid client credentials:
  - `getSpotifyAccessToken` now prefers client-credentials flow when `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` are configured.
  - Static token is now fallback-only when OAuth token refresh fails.
  - Static token normalization now strips optional `Bearer ` prefix.
- Added diagnostics enrichment to auth status payload:
  - `spotifyAuthDiagnostics` now includes `authMode` (`client_credentials`, `static_token`, `missing`).
- Reduced persistent false negatives from cache:
  - `TrackCache` now skips storing pools with zero playable previews (`previewUrl`), avoiding 5-minute lock-in of unplayable results.
- Improved source parsing resilience:
  - `spotify:playlist:<...>` now accepts raw ID, Spotify URL, or Spotify URI payload forms.
  - `deezer:playlist:<...>` now accepts Deezer playlist URLs.
- Added tests:
  - `apps/api/tests/spotify-auth.spec.ts` for token priority/fallback/normalization.
  - Extended `apps/api/tests/track-source-resolver.spec.ts` for URL normalization.
  - Added `apps/api/tests/spotify-playlist-parser.spec.ts` to validate Spotify playlist payload parsing for both `item` (current) and `track` (legacy) fields.
- Updated Spotify playlist parsing to support both response shapes from the Web API:
  - playlist entries are now mapped from `item.item` or `item.track`.
- Added additional runtime hardening:
  - Spotify playlist fetch now tries `/v1/playlists/{id}/items` first, then `/tracks` legacy fallback.
  - `SPOTIFY_POPULAR_PLAYLIST_IDS` entries are normalized (raw ID, URL, or URI accepted).
  - Invalid playlist IDs now emit explicit backend warning logs.
  - Preview coverage logs now include which endpoint shape was used (`items`, `tracks`, or none).
- Added integration resilience for mixed deployment setups:
  - API now exposes diagnostics on both `/health/details` and `/api/health/details`.
  - Frontend API client now auto-discovers/fallbacks API base URLs in this order:
    1) `VITE_API_BASE_URL` (if set),
    2) same-origin `/api`,
    3) same-origin root,
    4) `http://127.0.0.1:3001`,
    5) `http://localhost:3001`.
  - Frontend dev server now proxies `/api` to `http://127.0.0.1:3001`.
- Added source diagnostics helper:
  - `GET /music/source/resolve` now returns `previewCount` and `withoutPreviewCount` to quickly verify playable audio coverage per source.

## 2026-02-19 - YouTube-first playback pivot

- Implemented YouTube-first playback strategy while keeping external sources for catalog/playlist input:
  - Source tracks from Spotify/Deezer/AniList/search are now post-processed to prioritize YouTube playback candidates.
  - If YouTube match is found, playback uses YouTube provider media; if not, fallback keeps original provider track.
  - Added module-level YouTube match cache per `title+artist` signature to reduce repeated lookups.
- Updated track playability rules:
  - A track is now playable if it has audio preview OR YouTube/YouTube Music playback.
  - `RoomStore.startGame` no longer drops YouTube-only tracks with null `previewUrl`.
  - `TrackCache` now caches pools based on playable tracks (not preview-only).
- Frontend playback flow updated:
  - During `playing`, when media provider is YouTube/YouTube Music, a hidden autoplay iframe is mounted for audio/clip playback.
  - Existing hidden `<audio>` playback remains for direct preview URLs (Spotify/Deezer/etc.).
  - Added reveal clip rendering (`iframe`) when reveal embed URL exists.
  - Updated no-track UX message from preview-only wording to generic `audio/clip` wording.
- API/video robustness improvements:
  - YouTube embed params hardened for gameplay (`autoplay`, `controls=0`, `modestbranding`, etc.).
  - Added `youtubePlaybackCount` in room-start coverage logs.
- Security hardening:
  - Sensitive query params in provider URLs (e.g. YouTube `key`) are redacted in music HTTP logs.

## 2026-02-19 - YouTube-only playback enforcement

- Enforced strict runtime rule: no non-YouTube playback.
  - Tracks are now considered playable only when they resolve to YouTube/YouTube Music playback.
  - Preview-only tracks from Spotify/Deezer are no longer accepted as playable.
- Updated source resolver behavior:
  - Conversion now keeps only successfully resolved YouTube tracks.
  - Non-YouTube source tracks are dropped instead of being kept as fallback playback.
  - If source conversion yields too few tracks, resolver attempts direct YouTube search fill using source query.
- Updated gameplay tests to reflect YouTube-only rounds and embed expectations.
- Added dedicated unit test suite for playability policy:
  - `apps/api/tests/playback-support.spec.ts`.

### New files

- `apps/api/src/services/PlaybackSupport.ts`
- `apps/api/tests/playback-support.spec.ts`

### Updated tests

- Added `RoomStore` coverage for YouTube-only playable tracks without previews.
- Existing API + web suites remain green after pivot.

### Test runs (latest)

- `bun run lint`: PASS
- `bun run test`: PASS (57 tests)
- `npx playwright test`: PASS (2 specs)
- `bun run lint`: PASS
- `bun run test`: PASS (45 tests)
- `npx playwright test`: PASS (2 specs)

## 2026-02-19 - No-tracks hotfix (Spotify/Deezer -> YouTube playback)

- Hardened YouTube resolution pipeline to reduce false `NO_TRACKS_FOUND`:
  - Tracks already carrying YouTube/YTMusic playback are now accepted directly without re-querying YouTube API.
  - Added merged YouTube + YTMusic lookup helper for resolver search fills.
  - Added multi-query resolution fallback per track (`official audio`, plain query, `lyrics`) with dedupe.
  - Capped direct per-track resolution attempts with a strict budget to avoid excessive provider calls.
- Relaxed YouTube search restriction:
  - Removed `videoSyndicated=true` filter (kept `videoEmbeddable=true`) to avoid over-filtering legitimate music videos.
- Improved YouTube key compatibility:
  - `searchYouTube` now accepts fallback env var names: `YOUTUBE_API_KEY`, `GOOGLE_API_KEY`, `YT_API_KEY`.
- Reduced YouTube API pressure and failure loops:
  - Resolver now does a single lookup query per source track (instead of multi-query chain).
  - Added 60s temporary backoff when YouTube search returns provider failure (e.g. 403/network), preventing repeated burst retries.
- Root-cause fix for real runtime key loading:
  - Found that API launched from `apps/api` did not load root `.env`, so `YOUTUBE_API_KEY` was missing at runtime despite being set at repository root.
  - Updated API scripts to force root env loading:
    - `apps/api/package.json` `dev`: `bun --env-file=../../.env --hot src/index.ts`
    - `apps/api/package.json` `start`: `bun --env-file=../../.env src/index.ts`
- Removed non-API YouTube fallback to keep strict API-only behavior.
- Prevented stale cache regressions:
  - Track cache now invalidates cached entries that no longer contain playable YouTube tracks under current playback policy.
- Diagnostics ergonomics:
  - Health details now expose `hasYouTubeApiKey` and `hasYtMusicSearchUrl`.
- UX copy update:
  - No-track message now points only to `YOUTUBE_API_KEY` (YTMusic URL not required).

### Test runs (post-hotfix)

- `bun run lint`: PASS
- `bun run test`: PASS (57 tests)
- `npx playwright test`: PASS (2 specs)

## 2026-02-19 - Gameplay polish + playlist UX refinement

- Playlist sourcing quality improvements (Spotify):
  - Added playlist ranking heuristic for blindtest usability (`owner` official signals + `trackCount` + popular naming hints) so featured/category results prioritize stronger playlists first.
  - Added optional locale support via `SPOTIFY_LOCALE` for browse categories/featured/category playlists.
  - Kept live Spotify browse endpoints and fallback behavior intact.
- Live room data upgrade:
  - `RoomStore.roomState` now always returns a live ranking snapshot (not only in leaderboard/results) so the left-side classement can stay visible throughout the game.
- Playback continuity hardening:
  - Player and projection views now keep a stable YouTube iframe source keyed by track id/provider.
  - Avoids unnecessary iframe remount between `playing` and `reveal`, reducing restart/cut risk during reveal.
- Player arena UI refactor:
  - New 3-zone gameplay layout: left live leaderboard, center gameplay, right room metadata.
  - Reveal video integrated directly in center stage.
  - MCQ answers now show explicit lock feedback (`Réponse verrouillée`) similar to text mode.
- Home room creation UX refactor:
  - Replaced main source/category/playlist selects with visual controls:
    - source preset card grid,
    - category pills,
    - Spotify playlist cards with artwork/owner/track-count and active selection state,
    - local filter input for playlist list.
- CSS pass:
  - Added dedicated styles for source cards, category pills, playlist cards, arena side panels, compact leaderboard rows, and more robust hidden/reveal iframe behavior.

### Test runs (latest)

- `bun run lint`: PASS
- `bun run test`: PASS (57 tests)
- `npx playwright test`: PASS (2 specs)

## 2026-02-19 - UX cleanup + prod-like flow hardening

- Removed frontend local fallback room creation:
  - deleted `createRoomWithFallback` usage; room creation is now API-only (`createRoom`).
- Added room visibility config (public/private):
  - `POST /quiz/create` now accepts `{ isPublic, categoryQuery }`.
  - `RoomStore` stores `isPublic` per room.
  - Public list only includes `isPublic === true` rooms.
- Enforced setup-only joining:
  - `joinRoom` now rejects joins when room state is not `waiting`.
  - API returns `409 ROOM_NOT_JOINABLE` for late joins.
  - Public list marks non-joinable rooms as unavailable.
- Playlist UX and data flow overhaul:
  - Removed user-facing source presets that were requested to be removed (manual Spotify/Deezer, free text mode in UI).
  - Added unified playlist search endpoint: `GET /music/playlists/search?q=...` (Spotify + Deezer merged).
  - Added Deezer playlist search implementation.
  - Home page now uses unified playlist search cards (single search box, provider-agnostic selection).
- Fixed repeated/too-predictable rounds:
  - Track pool is shuffled at game start.
  - MCQ distractors/options are randomized per round build.
- In-game UI cleanup:
  - Removed large dev-like in-game top metrics bar.
  - Added compact round strip (`Room`, `Manche`).
  - Removed right-side technical metadata/query panel; replaced with chat placeholder panel.
  - Removed autoplay instruction text from player UI.
  - Centered/normalized answer input block layout.
- Timeline consistency update:
  - Added explicit leaderboard phase duration constant in player/projection progress logic.

### Tests (latest)

- `bun run lint`: PASS
- `bun run test`: PASS (58 tests)
- `npx playwright test`: PASS (2 specs)
