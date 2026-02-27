# Kwizik

Kwizik is a real-time multiplayer **anime blind test** game.

Players join a room, sync their AniList libraries, and guess anime names from AnimeThemes `.webm` openings/endings.

## Highlights

- Real-time room flow: `waiting -> countdown -> playing -> reveal -> leaderboard -> results`
- AniList account linking + manual sync
- AnimeThemes catalog mirror for playable OP/ED videos
- Anime-name answer input with autocomplete (aliases + acronyms)
- Guess phase hides video; reveal shows the same continuous media stream

## Tech Stack

- Runtime/package manager: Bun
- Frontend: React 19, Vite, TanStack Router, TanStack Query
- Backend: Elysia (TypeScript)
- Data: PostgreSQL + Redis
- Tests: Vitest + Playwright

## Monorepo Structure

```text
apps/
  api/        Backend (Elysia, services, tests)
  web/        Frontend (React/Vite)
packages/
  shared/     Shared package(s)
docs/         Plans and architecture docs
```

## Quick Start

1. Install dependencies

```bash
bun install
```

2. Copy env file

```bash
cp .env.example .env
```

3. Start local services

```bash
bun run docker:up
```

4. Run migrations

```bash
bun run db:migrate
```

5. Start app (2 terminals)

```bash
bun run dev:api
bun run dev:web
```

Default URLs:

- API: `http://127.0.0.1:3001`
- Web: `http://127.0.0.1:5173`

## Useful Scripts

```bash
bun run dev:api
bun run dev:web
bun run lint
bun run test
bun run test:e2e
```

## Environment

Main environment variables are documented in `.env.example`.

Anime-specific integration keys include:

- AniList OAuth (`ANILIST_CLIENT_ID`, `ANILIST_CLIENT_SECRET`, `ANILIST_REDIRECT_URI`)
- Optional AniList service token (`ANILIST_ACCESS_TOKEN`)
- Redis (`REDIS_URL`) for sync workers and queues
- AnimeThemes refresh tuning (`ANIMETHEMES_REFRESH_MAX_PAGES`, `ANIMETHEMES_REFRESH_INTERVAL_MS`)

## License

Private repository.
