# Kwizik

Kwizik is a real-time multiplayer music quiz game.

Players join a room, pick a music source, answer during timed rounds, and compete on a live leaderboard.

## Highlights

- Real-time room flow: `waiting -> countdown -> playing -> reveal -> leaderboard -> results`
- Multiplayer-ready lobby with host controls
- Source discovery from multiple providers (Spotify, Deezer, etc.)
- Gameplay playback is YouTube-only for consistent in-game media behavior
- Text and MCQ rounds with score + streak system
- Romanization support for Japanese titles/artists

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
docs/         Plans, handoff notes, deployment docs
scripts/      Project scripts (including changelog tooling)
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

## Changelist Workflow

This repo includes a lightweight changelist workflow:

- `CHANGELOG.md` stores an `Unreleased` section.
- `bun run changelog:add -- "<title>"` appends a dated entry with current changed files.

Examples:

```bash
bun run changelog:add -- "Improve lobby loading state"
bun run changelog:add -- "Fix YouTube candidate ranking" --note "Reduced irrelevant matches"
```

Optional flags:

- `--note "<text>"` can be repeated
- `--all` keeps all detected file paths in the entry (default output is truncated for readability)

## Environment

Main environment variables are documented in `.env.example`.

Music-related keys include:

- Spotify (`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, OAuth redirect URI)
- Deezer (`DEEZER_APP_ID`, `DEEZER_APP_SECRET`, OAuth redirect URI)
- YouTube (`YOUTUBE_API_KEY` or `YOUTUBE_API_KEYS`)
- Optional fallback config (`YOUTUBE_INVIDIOUS_INSTANCES`, `YTMUSIC_SEARCH_URL`)

## Deployment

Railway deployment workflows are available in `.github/workflows/`.

See:

- `docs/railway-first-deploy.md`

## License

Private repository. Add a license file if you plan to open-source the project.
