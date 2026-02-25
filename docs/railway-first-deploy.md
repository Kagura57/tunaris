# First Deploy Railway (Tunaris)

Ce guide déploie `web + api + postgres + redis` sur Railway.

## 1. Préparer le repo

- Branche propre, puis push sur GitHub.
- Vérifie que ces scripts existent:
  - API: `apps/api/package.json` -> `start: bun src/index.ts`
  - Web: `apps/web/package.json` -> `start: vite preview ... --port $PORT`

## 2. Créer le projet Railway

- Crée un projet Railway.
- Connecte le repo GitHub `tunaris`.

## 3. Créer les services

Crée 4 services:

1. `api` (source: repo, root directory `apps/api`)
2. `web` (source: repo, root directory `apps/web`)
3. `postgres` (Railway PostgreSQL plugin)
4. `redis` (Railway Redis plugin)

## 4. Config service API

Dans le service `api`:

- Build command: `bun install`
- Start command: `bun run start`

Variables à définir:

- `DATABASE_URL` (injectée par service Postgres)
- `REDIS_URL` (injectée par service Redis)
- `BETTER_AUTH_SECRET` (long secret)
- `BETTER_AUTH_URL` (URL publique du service API, ex: `https://api-xxx.up.railway.app`)
- `BETTER_AUTH_TRUSTED_ORIGINS` (URL publique du web, ex: `https://web-xxx.up.railway.app`)
- `MUSIC_TOKEN_ENCRYPTION_KEY` (fortement recommandé)
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_OAUTH_REDIRECT_URI` = `https://<api-domain>/account/music/spotify/connect/callback`
- `DEEZER_APP_ID` / `DEEZER_APP_SECRET` / `DEEZER_OAUTH_REDIRECT_URI` (si Deezer actif)
- `YOUTUBE_API_KEY` (ou `YOUTUBE_API_KEYS`)
- `DEEZER_ENABLED=true`
- `LOG_LEVEL=info`

Important:

- `PORT` est fourni automatiquement par Railway.
- L'API lit maintenant `process.env.PORT`.

## 5. Config service Web

Dans le service `web`:

- Build command: `bun install && bun run build`
- Start command: `bun run start`

Variables à définir:

- `VITE_API_BASE_URL=https://<api-domain>`

## 6. Migration DB en prod

Après le premier deploy API, lance la migration dans le shell Railway du service API:

```bash
bun src/db/migrate.ts
```

## 7. Vérifications rapides

API:

- `GET https://<api-domain>/health/details` doit répondre `ok: true`.
- Vérifie `integrations` et `providers`.

Web:

- Ouvre l'app.
- Connecte Spotify.
- Clique sync si besoin.
- Crée une room et lance une partie.

## 8. Points d'attention

- Si `/music/library/sync` renvoie `503`, vérifier `REDIS_URL` et le service Redis.
- Si auth social ne revient pas, vérifier `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, et les redirect URIs Spotify/Deezer.
- Si CORS/cookies bloquent, garder `web` dans `BETTER_AUTH_TRUSTED_ORIGINS` exact (https, domaine exact).
