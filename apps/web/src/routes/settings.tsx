import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  getAccountTitlePreference,
  getAniListRecoveredLibrary,
  getAniListLibrarySyncStatus,
  getAniListLinkStatus,
  getAuthSession,
  HttpStatusError,
  queueAniListLibrarySync,
  signOutAccount,
  type TitlePreference,
  updateAccountTitlePreference,
  updateAniListUsername,
} from "../lib/api";
import { notify } from "../lib/notify";
import { useGameStore } from "../stores/gameStore";

type AniListLinkStatus = "linked" | "not_linked";

function anilistStatusMeta(status: AniListLinkStatus) {
  if (status === "linked") {
    return {
      label: "Pret",
      tone: "connected",
      description: "Pseudo AniList configure pour les manches anime.",
    } as const;
  }
  return {
    label: "Non configure",
    tone: "idle",
    description: "Renseigne ton pseudo AniList puis clique Mettre a jour.",
  } as const;
}

function syncStatusLabel(status: "queued" | "running" | "success" | "error" | "idle") {
  if (status === "queued") return "en file";
  if (status === "running") return "en cours";
  if (status === "success") return "terminee";
  if (status === "error") return "en erreur";
  return "idle";
}

function syncErrorMessage(code: string | null | undefined) {
  const normalized = typeof code === "string" ? code.trim() : "";
  if (!normalized) return "Erreur de synchronisation AniList.";
  if (normalized === "ANILIST_USERNAME_NOT_SET") {
    return "Renseigne ton pseudo AniList avant de synchroniser.";
  }
  if (normalized === "ANILIST_USER_NOT_FOUND") {
    return "Pseudo AniList introuvable. Verifie le nom puis relance.";
  }
  if (normalized === "ANILIST_COLLECTION_GRAPHQL_ERROR") {
    return "AniList a retourne une erreur GraphQL. Reessaie dans quelques secondes.";
  }
  if (normalized === "ANIME_CATALOG_EMPTY") {
    return "Le catalogue anime local est vide. Laisse l'API finir son rafraichissement AnimeThemes puis relance.";
  }
  if (normalized.startsWith("ANILIST_COLLECTION_HTTP_")) {
    return `AniList a retourne ${normalized.replace("ANILIST_COLLECTION_HTTP_", "HTTP ")}. Reessaie dans quelques secondes.`;
  }
  if (normalized === "QUEUE_UNAVAILABLE" || normalized === "ENQUEUE_FAILED") {
    return "La file de synchronisation est indisponible pour le moment.";
  }
  return `Erreur sync AniList: ${normalized}`;
}

function updateMutationErrorMessage(error: unknown) {
  if (!(error instanceof HttpStatusError)) {
    return "Impossible de mettre a jour la liste AniList.";
  }
  if (error.message === "INVALID_ANILIST_USERNAME") {
    return "Pseudo AniList invalide (lettres, chiffres, _ ou - uniquement).";
  }
  if (error.message === "ANILIST_USERNAME_NOT_SET") {
    return "Renseigne ton pseudo AniList avant la mise a jour.";
  }
  if (error.message === "QUEUE_UNAVAILABLE" || error.message === "ENQUEUE_FAILED") {
    return "Pseudo enregistre, mais la file de sync est indisponible.";
  }
  return "Impossible de mettre a jour la liste AniList.";
}

function formatSyncTimestamp(ts: number | null | undefined) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "jamais";
  return new Date(ts).toLocaleString("fr-FR");
}

export function SettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setAccount = useGameStore((state) => state.setAccount);
  const clearAccount = useGameStore((state) => state.clearAccount);
  const [anilistUsernameInput, setAniListUsernameInput] = useState("");
  const [usernameDirty, setUsernameDirty] = useState(false);

  const sessionQuery = useQuery({
    queryKey: ["auth-session"],
    queryFn: getAuthSession,
    retry: false,
  });

  useEffect(() => {
    if (!sessionQuery.isSuccess) return;
    if (!sessionQuery.data?.user) {
      clearAccount();
      return;
    }
    setAccount({
      userId: sessionQuery.data.user.id,
      name: sessionQuery.data.user.name,
      email: sessionQuery.data.user.email,
    });
  }, [clearAccount, sessionQuery.data, sessionQuery.isSuccess, setAccount]);

  const anilistLinkQuery = useQuery({
    queryKey: ["anilist-link-status"],
    queryFn: getAniListLinkStatus,
    enabled: Boolean(sessionQuery.data?.user),
  });

  const anilistSyncStatusQuery = useQuery({
    queryKey: ["anilist-sync-status"],
    queryFn: getAniListLibrarySyncStatus,
    enabled: Boolean(sessionQuery.data?.user),
    refetchInterval: (query) => {
      const runStatus = query.state.data?.run?.status;
      return runStatus === "queued" || runStatus === "running" ? 2_000 : false;
    },
  });

  const anilistRecoveredLibraryQuery = useQuery({
    queryKey: ["anilist-recovered-library", sessionQuery.data?.user?.id ?? null],
    queryFn: () => getAniListRecoveredLibrary({ limit: 5_000 }),
    enabled: Boolean(sessionQuery.data?.user),
    refetchInterval: () => {
      const runStatus = anilistSyncStatusQuery.data?.run?.status;
      return runStatus === "queued" || runStatus === "running" ? 2_000 : false;
    },
  });

  const titlePreferenceQuery = useQuery({
    queryKey: ["account-title-preference"],
    queryFn: getAccountTitlePreference,
    enabled: Boolean(sessionQuery.data?.user),
  });

  useEffect(() => {
    if (!sessionQuery.data?.user) return;
    if (!titlePreferenceQuery.isSuccess) return;
    setAccount({
      titlePreference: titlePreferenceQuery.data.titlePreference,
    });
  }, [
    sessionQuery.data?.user,
    setAccount,
    titlePreferenceQuery.data?.titlePreference,
    titlePreferenceQuery.isSuccess,
  ]);

  useEffect(() => {
    if (usernameDirty) return;
    const username = anilistLinkQuery.data?.link?.anilistUsername ?? "";
    setAniListUsernameInput(username);
  }, [anilistLinkQuery.data?.link?.anilistUsername, usernameDirty]);

  const updateAndSyncMutation = useMutation({
    mutationFn: async () => {
      const username = anilistUsernameInput.trim();
      await updateAniListUsername({ username });
      if (!username) {
        return { queued: false as const };
      }
      const queued = await queueAniListLibrarySync();
      return {
        queued: true as const,
        runId: queued.runId,
      };
    },
    onSettled: async () => {
      setUsernameDirty(false);
      await anilistLinkQuery.refetch();
      await anilistSyncStatusQuery.refetch();
      await anilistRecoveredLibraryQuery.refetch();
    },
    onSuccess: (result) => {
      notify.success(
        result.queued
          ? "Pseudo mis à jour et synchronisation AniList lancée."
          : "Pseudo AniList mis à jour.",
      );
    },
    onError: (error) => {
      notify.error(updateMutationErrorMessage(error), {
        key: "settings:anilist:update:error",
      });
    },
  });

  const updateTitlePreferenceMutation = useMutation({
    mutationFn: (titlePreference: TitlePreference) =>
      updateAccountTitlePreference({
        titlePreference,
      }),
    onSuccess: (payload) => {
      setAccount({
        titlePreference: payload.titlePreference,
      });
      notify.success("Préférence de titre mise à jour.");
    },
    onError: () => {
      notify.error("Impossible de mettre a jour la preference de titre.", {
        key: "settings:title-preference:error",
      });
    },
    onSettled: async () => {
      await titlePreferenceQuery.refetch();
    },
  });

  const signOutMutation = useMutation({
    mutationFn: signOutAccount,
    onSuccess: async () => {
      clearAccount();
      await queryClient.invalidateQueries({ queryKey: ["auth-session"] });
      await queryClient.invalidateQueries({ queryKey: ["anilist-link-status"] });
      await queryClient.invalidateQueries({ queryKey: ["anilist-sync-status"] });
      await queryClient.invalidateQueries({ queryKey: ["account-title-preference"] });
      notify.success("Déconnexion effectuée.");
      navigate({ to: "/" });
    },
    onError: () => {
      notify.error("Deconnexion impossible pour le moment.", {
        key: "settings:signout:error",
      });
    },
  });

  const user = sessionQuery.data?.user ?? null;
  const linkStatus = (anilistLinkQuery.data?.status ?? "not_linked") as AniListLinkStatus;
  const linkStatusMeta = anilistStatusMeta(linkStatus);
  const activeRun = anilistSyncStatusQuery.data?.run ?? null;
  const runStatus = activeRun?.status ?? "idle";
  const lastCompletedAtMs = activeRun?.finishedAtMs ?? null;
  const recoveredAnimeItems = anilistRecoveredLibraryQuery.data?.items ?? [];
  const recoveredAnimeCount = anilistRecoveredLibraryQuery.data?.total ?? 0;
  const titlePreference = titlePreferenceQuery.data?.titlePreference ?? "mixed";

  useEffect(() => {
    if (!anilistRecoveredLibraryQuery.isError) return;
    notify.error("Impossible de charger la bibliotheque anime.", {
      key: "settings:anilist-library:error",
    });
  }, [anilistRecoveredLibraryQuery.isError]);

  useEffect(() => {
    if (activeRun?.status !== "error") return;
    notify.error(syncErrorMessage(activeRun.message), {
      key: `settings:anilist-sync-run:error:${activeRun.runId ?? activeRun.createdAtMs ?? "latest"}`,
    });
  }, [activeRun?.createdAtMs, activeRun?.message, activeRun?.runId, activeRun?.status]);

  return (
    <section className="single-panel">
      <article className="panel-card">
        <h2 className="panel-title">Profil & connexions</h2>
        <p className="panel-copy">
          Renseigne ton pseudo AniList puis clique Mettre a jour quand tu veux rafraichir ta liste.
        </p>

        {!sessionQuery.isPending && !user && (
          <div className="panel-form">
            <p className="status">Tu dois etre connecte pour gerer ton pseudo AniList.</p>
            <div className="waiting-actions">
              <Link className="solid-btn" to="/auth">
                Se connecter
              </Link>
              <Link className="ghost-btn" to="/">
                Retour accueil
              </Link>
            </div>
          </div>
        )}

        {sessionQuery.isPending && <p className="status">Chargement du compte...</p>}

        {user && (
          <div className="panel-form">
            <p className="status">
              Connecte: <strong>{user.name}</strong> ({user.email})
            </p>

            <div className="provider-link-card">
              <div className="provider-link-head">
                <div>
                  <p className="kicker">AniList</p>
                  <h3>Pseudo AniList</h3>
                </div>
                <span className={`provider-badge ${linkStatusMeta.tone}`}>
                  {linkStatusMeta.label}
                </span>
              </div>
              <p className="status">{linkStatusMeta.description}</p>
              <label>
                <span>Pseudo AniList</span>
                <input
                  value={anilistUsernameInput}
                  onChange={(event) => {
                    setUsernameDirty(true);
                    setAniListUsernameInput(event.currentTarget.value);
                  }}
                  placeholder="Ton pseudo AniList"
                  maxLength={50}
                />
              </label>
              <div className="waiting-actions">
                <button
                  className="solid-btn"
                  type="button"
                  disabled={updateAndSyncMutation.isPending || signOutMutation.isPending}
                  onClick={() => updateAndSyncMutation.mutate()}
                >
                  {updateAndSyncMutation.isPending ? "Mise a jour..." : "Mettre a jour"}
                </button>
              </div>
              <p className="status">
                Derniere sync: <strong>{formatSyncTimestamp(lastCompletedAtMs)}</strong>
              </p>
            </div>

            <div className="provider-link-card">
              <div className="provider-link-head">
                <div>
                  <p className="kicker">Anime Quiz</p>
                  <h3>Preference de titre</h3>
                </div>
                <span className="provider-badge connected">{titlePreference}</span>
              </div>
              <p className="status">Choisis le format affiche pour les choix QCM anime.</p>
              <div className="waiting-actions">
                {(
                  [
                    { value: "mixed", label: "Mixte" },
                    { value: "romaji", label: "Romaji" },
                    { value: "english", label: "Anglais" },
                  ] as Array<{ value: TitlePreference; label: string }>
                ).map((entry) => (
                  <button
                    key={entry.value}
                    className={titlePreference === entry.value ? "solid-btn" : "ghost-btn"}
                    type="button"
                    disabled={updateTitlePreferenceMutation.isPending || signOutMutation.isPending}
                    onClick={() => updateTitlePreferenceMutation.mutate(entry.value)}
                  >
                    {titlePreference === entry.value && updateTitlePreferenceMutation.isPending
                      ? "Mise a jour..."
                      : entry.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="provider-link-card">
              <div className="provider-link-head">
                <div>
                  <p className="kicker">AniList</p>
                  <h3>Etat synchronisation</h3>
                </div>
                <span
                  className={`provider-badge ${runStatus === "error" ? "expired" : "connected"}`}
                >
                  {syncStatusLabel(runStatus)}
                </span>
              </div>
              <p className="status">
                Progression:{" "}
                <strong>
                  {typeof activeRun?.progress === "number" ? `${activeRun.progress}%` : "0%"}
                </strong>
              </p>
              <p className="status">
                Derniere execution: {formatSyncTimestamp(activeRun?.createdAtMs ?? null)}
              </p>
            </div>

            <div className="provider-link-card">
              <div className="provider-link-head">
                <div>
                  <p className="kicker">AniList</p>
                  <h3>Animes recuperes</h3>
                </div>
                <span
                  className={`provider-badge ${recoveredAnimeCount > 0 ? "connected" : "idle"}`}
                >
                  {recoveredAnimeCount}
                </span>
              </div>
              <p className="status">
                Titres presents dans la bibliotheque synchronisee locale (watching + completed).
              </p>

              {anilistRecoveredLibraryQuery.isPending && (
                <p className="status">Chargement de la bibliotheque anime...</p>
              )}

              {anilistRecoveredLibraryQuery.isError && (
                <p className="status error">Impossible de charger la bibliotheque anime.</p>
              )}

              {!anilistRecoveredLibraryQuery.isPending && recoveredAnimeItems.length <= 0 && (
                <p className="status">
                  Aucun anime trouve pour le moment. Lance une synchronisation puis recharge cette
                  page.
                </p>
              )}

              {recoveredAnimeItems.length > 0 && (
                <ul className="anilist-library-list">
                  {recoveredAnimeItems.map((entry) => (
                    <li
                      key={`${entry.animeId}:${entry.listStatus}`}
                      className="anilist-library-item"
                    >
                      <strong>{entry.title}</strong>
                      <span
                        className={`anilist-library-status${
                          entry.listStatus === "WATCHING" ? " watching" : " completed"
                        }`}
                      >
                        {entry.listStatus === "WATCHING" ? "Watching" : "Completed"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="waiting-actions">
              <button
                className="ghost-btn danger-btn"
                type="button"
                disabled={signOutMutation.isPending || updateAndSyncMutation.isPending}
                onClick={() => signOutMutation.mutate()}
              >
                {signOutMutation.isPending ? "Deconnexion..." : "Se deconnecter"}
              </button>
              <Link className="ghost-btn" to="/">
                Retour accueil
              </Link>
            </div>
          </div>
        )}
      </article>
    </section>
  );
}
