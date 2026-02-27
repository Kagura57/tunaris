# Refonte Musique Generaliste (Playlists Spotify Publiques) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remplacer l'ancien flux Spotify utilisateur (OAuth + Liked Songs) par un flux Spotify serveur (Client Credentials) pour importer des playlists publiques, puis jouer les manches en audio iTunes (guess) et video YouTube (reveal).

**Architecture:** Introduire un `SpotifyService` backend unique qui gere le token serveur Spotify en memoire et centralise les appels playlist. Le resolver de sources devient dual-source: il produit une URL audio (preview iTunes 30s) et une URL video (clip YouTube officiel), puis `RoomStore` expose un contrat explicite `audioUrl`/`videoUrl` pour synchroniser proprement les transitions front (audio-only pendant guess, video-only pendant reveal). Le lobby host abandonne la recherche Deezer et passe a un import explicite par URL Spotify publique.

**Tech Stack:** Bun, TypeScript, Elysia API, React 19 + Zustand + TanStack Query, Vitest.

---

## Skill References

- `@brainstorming` pour cadrer la refonte et les compromis avant implementation.
- `@writing-plans` pour ce plan de travail detaille.
- `@executing-plans` pour execution batch par batch apres validation.

---

### Task 1: Creer un SpotifyService serveur (Client Credentials + cache memoire)

**Files:**
- Create: `apps/api/src/services/SpotifyService.ts`
- Modify: `apps/api/src/routes/music/spotify.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/tests/spotify-service.spec.ts`
- Remove/replace: `apps/api/tests/spotify-auth.spec.ts`

**Step 1: Ecrire les tests en echec du nouveau service token**

- Cas a couvrir:
  - token obtenu via `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET`.
  - token reutilise tant qu'il n'est pas expire.
  - refresh force a expiration.
  - erreur explicite si credentials absents.

**Step 2: Executer les tests pour verifier l'echec**

Run: `bun test apps/api/tests/spotify-service.spec.ts -t "client credentials|cache"`  
Expected: FAIL car `SpotifyService.ts` n'existe pas encore.

**Step 3: Implementer le service**

- Ajouter:
  - `getServerAccessToken()`
  - cache memoire `{ token, expiresAtMs }`
  - marge de securite avant expiration (ex: 30s)
  - reset cache pour les tests.
- Retirer l'usage direct de `spotify-auth.ts` depuis les routes Spotify.

**Step 4: Rebrancher les diagnostics health**

- Mettre `index.ts` sur un diagnostic provenant du nouveau service.
- Conserver un payload health compatible.

**Step 5: Relancer les tests cibles**

Run: `bun test apps/api/tests/spotify-service.spec.ts apps/api/tests/spotify-playlist-parser.spec.ts`  
Expected: PASS sur le nouveau service, parser Spotify toujours vert.

**Step 6: Commit**

```bash
git add apps/api/src/services/SpotifyService.ts apps/api/src/routes/music/spotify.ts apps/api/src/index.ts apps/api/tests/spotify-service.spec.ts apps/api/tests/spotify-auth.spec.ts
git commit -m "refactor(spotify): move server auth to SpotifyService client-credentials cache"
```

---

### Task 2: Ajouter l'endpoint d'import de playlist Spotify publique

**Files:**
- Modify: `apps/api/src/routes/music/source.ts`
- Modify: `apps/api/src/routes/music/spotify.ts`
- Modify: `apps/api/src/services/TrackSourceResolver.ts`
- Test: `apps/api/tests/music-source-routes.spec.ts`

**Step 1: Ecrire les tests en echec pour `POST /api/music/playlist/import`**

- Cas:
  - accepte une URL playlist Spotify publique valide.
  - normalise URL/URI/id et renvoie `sourceQuery` coherent.
  - renvoie `name`, `trackCount`, `playlistId`, `tracks`.
  - rejette payload vide/invalide (400).

**Step 2: Executer les tests pour verifier l'echec**

Run: `bun test apps/api/tests/music-source-routes.spec.ts -t "playlist import|spotify public playlist"`  
Expected: FAIL car route absente.

**Step 3: Implementer l'endpoint**

- Ajouter route POST sous `/music/playlist/import` et alias `/api/music/playlist/import`.
- Input: `{ url: string }`.
- Flow:
  - extraire/normaliser `playlistId`.
  - fetch metadata playlist + tracks via token serveur.
  - reponse avec objet selectionnable en lobby (incluant `sourceQuery: spotify:playlist:<id>`).

**Step 4: Garder la compatibilite RoomStore**

- Conserver `setRoomPublicPlaylist` mais accepter un `sourceQuery` Spotify.
- Pas de fallback de lecture non-YouTube en reveal.

**Step 5: Reexecuter les tests cibles**

Run: `bun test apps/api/tests/music-source-routes.spec.ts apps/api/tests/track-source-resolver.spec.ts`  
Expected: PASS.

**Step 6: Commit**

```bash
git add apps/api/src/routes/music/source.ts apps/api/src/routes/music/spotify.ts apps/api/src/services/TrackSourceResolver.ts apps/api/tests/music-source-routes.spec.ts
git commit -m "feat(music): add spotify public playlist import endpoint"
```

---

### Task 3: Remplacer le lobby host par un input URL Spotify

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/src/styles.css`

**Step 1: Ecrire les tests/guards UI en echec**

- `play.tsx`:
  - plus de grille de recherche Deezer pour `public_playlist`.
  - champ URL Spotify + bouton importer.
  - etat loading + message erreur import.

**Step 2: Verifier l'echec**

Run: `bun test apps/web/src/routes/live-gameplay.spec.tsx`  
Expected: FAIL/coverage insuffisante sur nouveaux champs tant que non implemente.

**Step 3: Implementer le nouveau flux lobby**

- Ajouter `importSpotifyPlaylist()` dans `api.ts`.
- Dans `play.tsx` (host):
  - input texte URL playlist Spotify.
  - mutation import -> `setRoomPublicPlaylist` avec donnees importees.
  - afficher playlist selectionnee (nom + count).
- Supprimer la dependance UX a `searchPlaylistsAcrossProviders` pour ce mode.

**Step 4: Verifier parcours host**

Run: `bun test apps/web/src/routes/live-gameplay.spec.tsx`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/routes/room/$roomCode/play.tsx apps/web/src/styles.css apps/web/src/routes/live-gameplay.spec.tsx
git commit -m "feat(web): switch public-playlist lobby to spotify url import"
```

---

### Task 4: Passer TrackSourceResolver en dual-source (`audioUrl` iTunes + `videoUrl` YouTube)

**Files:**
- Modify: `apps/api/src/services/music-types.ts`
- Modify: `apps/api/src/services/TrackSourceResolver.ts`
- Modify: `apps/api/src/repositories/ResolvedTrackRepository.ts`
- Test: `apps/api/tests/track-source-resolver-cache.spec.ts`
- Test: `apps/api/tests/track-source-resolver.spec.ts`

**Step 1: Ecrire les tests en echec sur le nouveau contrat**

- Le resolver doit renvoyer:
  - `audioUrl` via iTunes public API (`previewUrl`).
  - `videoUrl` via YouTube recherche "official video/music video".
- Cas de fallback:
  - pas de preview iTunes -> track ignoree pour phase guess.
  - video YouTube absente -> track ignoree/retry.

**Step 2: Executer les tests**

Run: `bun test apps/api/tests/track-source-resolver.spec.ts apps/api/tests/track-source-resolver-cache.spec.ts`  
Expected: FAIL car contrat actuel repose sur `previewUrl/sourceUrl`.

**Step 3: Implementer le dual resolver**

- Etendre type `MusicTrack`:
  - `audioUrl: string | null`
  - `videoUrl: string | null`
  - garder `previewUrl/sourceUrl` temporairement en alias de compatibilite le temps de migration.
- Resolution:
  - source track Spotify playlist.
  - `audioUrl` via iTunes query `{artist} {title}`.
  - `videoUrl` via ranking YouTube "official video/music video".
- Persister/cacher video YouTube existant; cacher audio iTunes en memoire (TTL raisonnable).

**Step 4: Verifier la priorisation des tracks jouables**

- Garder uniquement tracks ayant `audioUrl` et `videoUrl`.
- Logs explicites sur taux de couverture audio/video.

**Step 5: Reexecuter tests cibles**

Run: `bun test apps/api/tests/track-source-resolver.spec.ts apps/api/tests/track-source-resolver-cache.spec.ts apps/api/tests/playback-support.spec.ts`  
Expected: PASS.

**Step 6: Commit**

```bash
git add apps/api/src/services/music-types.ts apps/api/src/services/TrackSourceResolver.ts apps/api/src/repositories/ResolvedTrackRepository.ts apps/api/tests/track-source-resolver.spec.ts apps/api/tests/track-source-resolver-cache.spec.ts apps/api/tests/playback-support.spec.ts
git commit -m "feat(resolver): return dual audio/video sources using iTunes preview and YouTube clip"
```

---

### Task 5: Adapter RoomStore + contrat realtime pour gerer deux lecteurs

**Files:**
- Modify: `apps/api/src/services/RoomStore.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/stores/gameStore.ts`
- Modify: `apps/web/src/routes/room/$roomCode/play.tsx`
- Modify: `apps/web/src/routes/room/$roomCode/view.tsx`
- Test: `apps/api/tests/room-store.spec.ts`

**Step 1: Ecrire tests backend en echec sur phases**

- `playing`:
  - expose `audioUrl` non null.
  - n'expose pas de video active.
- `reveal`:
  - coupe audio.
  - expose `videoUrl`/`embedUrl` YouTube.

**Step 2: Executer tests backend**

Run: `bun test apps/api/tests/room-store.spec.ts -t "playing|reveal|youtube|audio"`  
Expected: FAIL tant que contrat non migre.

**Step 3: Implementer contrat d'etat**

- API snapshot:
  - `audioUrl` (guess)
  - `media.videoUrl`/`embedUrl` (reveal)
- `RoomStore`:
  - phase playing => audio actif, video non montee.
  - phase reveal => pause audio, monter video YouTube.

**Step 4: Implementer bascule front stricte**

- `gameStore.ts`: stocker explicitement `audioUrl` et `videoUrl`.
- `play.tsx` + `view.tsx`:
  - jouer uniquement `<audio>` pendant `playing`.
  - demonter/pause audio et afficher iframe YouTube pendant `reveal`.

**Step 5: Reexecuter tests**

Run: `bun test apps/api/tests/room-store.spec.ts apps/web/src/routes/live-gameplay.spec.tsx`  
Expected: PASS.

**Step 6: Commit**

```bash
git add apps/api/src/services/RoomStore.ts apps/web/src/lib/api.ts apps/web/src/stores/gameStore.ts apps/web/src/routes/room/$roomCode/play.tsx apps/web/src/routes/room/$roomCode/view.tsx apps/api/tests/room-store.spec.ts apps/web/src/routes/live-gameplay.spec.tsx
git commit -m "feat(gameplay): enforce audio-guess then youtube-reveal playback state contract"
```

---

### Task 6: Nettoyer l'ancien flux Spotify OAuth utilisateur (obsolete)

**Files:**
- Modify/Delete: `apps/api/src/routes/music/spotify-auth.ts`
- Modify: `apps/api/src/services/MusicOAuthService.ts`
- Modify: `apps/api/src/routes/account.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/routes/settings.tsx`
- Test: `apps/api/tests/music-oauth-sync-trigger.spec.ts`

**Step 1: Ecrire tests de non-regression API**

- verifier que les endpoints music account Spotify obsoletes:
  - ne declenchent plus sync liked songs Spotify.
  - renvoient erreur claire/deprecation si appeles.

**Step 2: Executer tests**

Run: `bun test apps/api/tests/music-oauth-sync-trigger.spec.ts apps/api/tests/music-library-routes.spec.ts`  
Expected: FAIL tant que vieux flux OAuth est actif.

**Step 3: Nettoyer le code obsolete**

- Supprimer la logique Spotify OAuth user dans `MusicOAuthService.ts`.
- Retirer/reduire `spotify-auth.ts` (ou le transformer en wrapper de compat temporaire vers `SpotifyService`).
- Supprimer les hooks UI "Connect Spotify / Liked Songs sync" devenus hors-scope.

**Step 4: Reexecuter tests**

Run: `bun test apps/api/tests/music-oauth-sync-trigger.spec.ts apps/api/tests/quiz-routes.spec.ts apps/api/tests/music-library-routes.spec.ts`  
Expected: PASS avec nouveau comportement deprecation.

**Step 5: Commit**

```bash
git add apps/api/src/routes/music/spotify-auth.ts apps/api/src/services/MusicOAuthService.ts apps/api/src/routes/account.ts apps/web/src/lib/api.ts apps/web/src/routes/settings.tsx apps/api/tests/music-oauth-sync-trigger.spec.ts apps/api/tests/music-library-routes.spec.ts
git commit -m "chore(spotify): remove obsolete user oauth liked-songs flow"
```

---

### Task 7: Validation E2E ciblee + documentation

**Files:**
- Modify: `docs/plans/2026-02-27-refonte-musique-generaliste-playlists-spotify-implementation-plan.md`
- Create/Modify (si necessaire): `apps/api/tests/flow.integration.spec.ts`

**Step 1: Executer la batterie backend/web ciblee**

Run: `bun test apps/api/tests/spotify-service.spec.ts apps/api/tests/music-source-routes.spec.ts apps/api/tests/track-source-resolver-cache.spec.ts apps/api/tests/room-store.spec.ts apps/web/src/routes/live-gameplay.spec.tsx`

Expected: PASS.

**Step 2: Smoke test manuel local**

- Host colle une URL Spotify publique valide.
- Import OK + playlist visible dans lobby.
- Round:
  - guess => audio iTunes seul.
  - reveal => audio coupe, video YouTube clip officiel lancee.

**Step 3: Ajouter notes de migration**

- Variables env requises:
  - `SPOTIFY_CLIENT_ID`
  - `SPOTIFY_CLIENT_SECRET`
- Contrat front mis a jour: `audioUrl` + `videoUrl`.

**Step 4: Commit final**

```bash
git add docs/plans/2026-02-27-refonte-musique-generaliste-playlists-spotify-implementation-plan.md apps/api/tests/flow.integration.spec.ts
git commit -m "docs: finalize spotify public playlist dual-source migration plan and checks"
```

---

## Risks and Guardrails

- Garder `videoUrl` YouTube comme unique source reveal (conforme au contrat produit).
- L'appel iTunes est non-authentifie: prevoir timeout court + cache en memoire + retry unique.
- Si import playlist retourne peu de tracks resolvables (audio+video), renvoyer erreur explicite au host.
- Eviter toute regression sur mode `anime` qui partage le pipeline RoomStore.

