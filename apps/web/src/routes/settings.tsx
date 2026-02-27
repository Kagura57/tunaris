import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  getAniListConnectUrl,
  getAniListLibrarySyncStatus,
  getAniListLinkStatus,
  getAuthSession,
  queueAniListLibrarySync,
  signOutAccount,
} from "../lib/api";
import { useGameStore } from "../stores/gameStore";

type AniListLinkStatus = "linked" | "not_linked" | "expired";

function anilistStatusMeta(status: AniListLinkStatus) {
  if (status === "linked") {
    return {
      label: "Connecte",
      tone: "connected",
      description: "Compte AniList pret pour generer les manches anime.",
    } as const;
  }
  if (status === "expired") {
    return {
      label: "Session expiree",
      tone: "expired",
      description: "Reconnecte AniList pour relancer les synchronisations.",
    } as const;
  }
  return {
    label: "Non connecte",
    tone: "idle",
    description: "Connecte AniList pour importer ta liste Watching/Completed.",
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
  if (normalized === "ANILIST_NOT_LINKED") {
    return "Aucun compte AniList lie. Connecte ton compte puis relance la synchronisation.";
  }
  if (normalized.startsWith("ANILIST_COLLECTION_HTTP_")) {
    return `AniList a retourne ${normalized.replace("ANILIST_COLLECTION_HTTP_", "HTTP ")}. Reessaie dans quelques secondes.`;
  }
  if (normalized === "QUEUE_UNAVAILABLE" || normalized === "ENQUEUE_FAILED") {
    return "La file de synchronisation est indisponible pour le moment.";
  }
  return `Erreur sync AniList: ${normalized}`;
}

export function SettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setAccount = useGameStore((state) => state.setAccount);
  const clearAccount = useGameStore((state) => state.clearAccount);

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

  const linked = anilistLinkQuery.data?.status === "linked";

  const anilistSyncStatusQuery = useQuery({
    queryKey: ["anilist-sync-status"],
    queryFn: getAniListLibrarySyncStatus,
    enabled: Boolean(sessionQuery.data?.user) && linked,
    refetchInterval: (query) => {
      const runStatus = query.state.data?.run?.status;
      return runStatus === "queued" || runStatus === "running" ? 2_000 : false;
    },
  });

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const payload = event.data as { source?: string; ok?: boolean } | null;
      if (!payload || payload.source !== "kwizik-anilist-oauth") return;
      if (payload.ok === true) {
        void anilistLinkQuery.refetch();
        void anilistSyncStatusQuery.refetch();
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [anilistLinkQuery, anilistSyncStatusQuery]);

  const connectMutation = useMutation({
    mutationFn: async () => {
      const payload = await getAniListConnectUrl({
        returnTo: window.location.href,
      });
      const popup = window.open(payload.authorizeUrl, "kwizik-anilist-oauth", "width=640,height=760");
      if (!popup) {
        window.location.assign(payload.authorizeUrl);
      }
      return payload;
    },
  });

  const syncMutation = useMutation({
    mutationFn: queueAniListLibrarySync,
    onSuccess: async () => {
      await anilistSyncStatusQuery.refetch();
    },
  });

  const signOutMutation = useMutation({
    mutationFn: signOutAccount,
    onSuccess: async () => {
      clearAccount();
      await queryClient.invalidateQueries({ queryKey: ["auth-session"] });
      await queryClient.invalidateQueries({ queryKey: ["anilist-link-status"] });
      await queryClient.invalidateQueries({ queryKey: ["anilist-sync-status"] });
      navigate({ to: "/" });
    },
  });

  const user = sessionQuery.data?.user ?? null;
  const linkStatus = (anilistLinkQuery.data?.status ?? "not_linked") as AniListLinkStatus;
  const linkStatusMeta = anilistStatusMeta(linkStatus);
  const activeRun = anilistSyncStatusQuery.data?.run ?? null;
  const runStatus = activeRun?.status ?? "idle";

  return (
    <section className="single-panel">
      <article className="panel-card">
        <h2 className="panel-title">Profil & connexions</h2>
        <p className="panel-copy">
          Lie ton compte AniList puis synchronise ta bibliotheque quand tu veux pour alimenter les rooms.
        </p>

        {!sessionQuery.isPending && !user && (
          <div className="panel-form">
            <p className="status">Tu dois etre connecte pour gerer ta connexion AniList.</p>
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
                  <h3>Compte AniList</h3>
                </div>
                <span className={`provider-badge ${linkStatusMeta.tone}`}>{linkStatusMeta.label}</span>
              </div>
              <p className="status">{linkStatusMeta.description}</p>
              {anilistLinkQuery.data?.link?.anilistUsername && (
                <p className="status">
                  Compte lie: <strong>{anilistLinkQuery.data.link.anilistUsername}</strong>
                </p>
              )}
              <div className="waiting-actions">
                <button
                  className="solid-btn"
                  type="button"
                  disabled={connectMutation.isPending || syncMutation.isPending}
                  onClick={() => connectMutation.mutate()}
                >
                  {connectMutation.isPending
                    ? "Connexion..."
                    : linkStatus === "linked"
                      ? "Reconnecter AniList"
                      : "Connecter AniList"}
                </button>
              </div>
            </div>

            {linked && (
              <div className="provider-link-card">
                <div className="provider-link-head">
                  <div>
                    <p className="kicker">AniList</p>
                    <h3>Synchronisation bibliotheque</h3>
                  </div>
                  <span className="provider-badge connected">Action manuelle</span>
                </div>
                <p className="status">
                  Etat sync: <strong>{syncStatusLabel(runStatus)}</strong>
                  {typeof activeRun?.progress === "number" ? ` (${activeRun.progress}%)` : ""}
                  {activeRun?.finishedAtMs ? " · derniere execution terminee" : ""}
                </p>
                <div className="waiting-actions">
                  <button
                    className="solid-btn"
                    type="button"
                    disabled={syncMutation.isPending}
                    onClick={() => syncMutation.mutate()}
                  >
                    {syncMutation.isPending ? "Synchronisation..." : "Synchroniser ma liste AniList"}
                  </button>
                </div>
              </div>
            )}

            <div className="waiting-actions">
              <button
                className="ghost-btn danger-btn"
                type="button"
                disabled={signOutMutation.isPending || syncMutation.isPending}
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

        <p
          className={
            connectMutation.isError ||
            signOutMutation.isError ||
            syncMutation.isError ||
            activeRun?.status === "error"
              ? "status error"
              : "status"
          }
        >
          {connectMutation.isError && "Impossible de lancer la connexion AniList."}
          {signOutMutation.isError && "Deconnexion impossible pour le moment."}
          {syncMutation.isError && "Impossible de lancer la synchronisation AniList."}
          {!syncMutation.isError && activeRun?.status === "error" && syncErrorMessage(activeRun.message)}
        </p>
      </article>
    </section>
  );
}
