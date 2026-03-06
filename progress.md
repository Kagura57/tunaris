Original prompt: Remplacer les feedbacks transitoires du site par un systeme de toasts global moderne et supprimer les vieux messages inline, avec une gestion plus propre des erreurs media dans la room.

- 2026-03-06: Ajout de `sonner` cote web et creation de `apps/web/src/lib/notify.ts` avec API centralisee (`success`, `error`, `info`, `loading`, `promise`, `dismiss`) et deduplication par `key`.
- 2026-03-06: Montage du `Toaster` global dans `apps/web/src/routes/__root.tsx` et ajout du theme toast dans `apps/web/src/styles.css`.
- 2026-03-06: Migration des feedbacks transitoires sur `auth.tsx`, `index.tsx`, `join.tsx` et `settings.tsx`.
- 2026-03-06: Migration des feedbacks room/player sur `apps/web/src/routes/room/$roomCode/play.tsx` et `apps/web/src/routes/room/$roomCode/view.tsx`, avec toasts dedupliques pour les erreurs AnimeThemes et les erreurs de synchronisation.
- 2026-03-06: Suppression du gros bloc `p.status error` legacy dans l'ecran de jeu et du bandeau projection audio legacy.
- 2026-03-06: AnimeThemes durci pour les stalls longs: auto-skip repousse a un timeout extreme partage avec l'API, et prechargement du `nextMedia` ajoute aussi sur la page joueur pour reduire le buffering entre manches.
- 2026-03-06: Tests verifies:
  - `bun test apps/web/src/lib/notify.spec.ts apps/web/src/routes`
  - `bun run build` dans `apps/web`
  - `bash ./scripts/playwright.sh test apps/web/e2e/toast-feedback.spec.ts`
  - `bun test apps/api/tests/room-store.spec.ts apps/api/tests/quiz-routes.spec.ts`
  - `bun test apps/web/src/routes/room-play-anime.spec.tsx apps/web/src/routes/live-gameplay.spec.tsx apps/web/src/lib/notify.spec.ts`
- TODO eventuel: harmoniser ensuite les erreurs inline de formulaires si on veut moderniser aussi les champs, sans tout convertir en toast.
