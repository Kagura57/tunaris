import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  disconnectMusicProvider,
  getAuthSession,
  getMySpotifyLibrarySyncStatus,
  getMusicProviderConnectUrl,
  getMusicProviderLinks,
  queueMySpotifyLibrarySync,
  signOutAccount,
} from "../lib/api";
import { useGameStore } from "../stores/gameStore";

type LinkableProvider = "spotify" | "deezer";
type ProviderLinkStatus = "linked" | "not_linked" | "expired";

function providerLabel(provider: LinkableProvider) {
  return provider === "spotify" ? "Spotify" : "Deezer";
}

function providerStatusMeta(status: ProviderLinkStatus) {
  if (status === "linked") {
    return {
      label: "Connecte",
      tone: "connected",
      description: "Compte pret pour tes playlists et titres likes.",
    } as const;
  }
  if (status === "expired") {
    return {
      label: "Session expiree",
      tone: "expired",
      description: "Reconnecte ce compte pour continuer a l'utiliser.",
    } as const;
  }
  return {
    label: "Non connecte",
    tone: "idle",
    description: "Connecte ce compte pour enrichir tes parties.",
  } as const;
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

  const providerLinksQuery = useQuery({
    queryKey: ["music-provider-links"],
    queryFn: getMusicProviderLinks,
    enabled: Boolean(sessionQuery.data?.user),
  });

  const spotifyLinked = providerLinksQuery.data?.providers?.spotify?.status === "linked";

  const librarySyncStatusQuery = useQuery({
    queryKey: ["music-library-sync-status"],
    queryFn: getMySpotifyLibrarySyncStatus,
    enabled: Boolean(sessionQuery.data?.user) && spotifyLinked,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "syncing" ? 2_000 : false;
    },
  });

  const syncErrorMessage = (() => {
    const code = librarySyncStatusQuery.data?.lastError ?? "";
    if (code === "SPOTIFY_SYNC_SCOPE_MISSING_USER_LIBRARY_READ") {
      return "Spotify n'a pas autorise l'acces aux titres likes. Reconnecte Spotify puis relance la sync.";
    }
    if (code === "SPOTIFY_SYNC_UNAUTHORIZED") {
      return "Session Spotify invalide ou expiree. Reconnecte Spotify puis relance la sync.";
    }
    if (code === "SPOTIFY_SYNC_FORBIDDEN") {
      return "Spotify a refuse la synchronisation pour ce compte. Reconnecte Spotify et reessaie.";
    }
    if (code === "SPOTIFY_SYNC_ACCOUNT_NOT_APPROVED") {
      return "Ce compte Spotify n'est pas autorise pour cette app Spotify. Ajoute-le dans le dashboard Spotify (utilisateur test), puis reconnecte-le.";
    }
    if (code === "SPOTIFY_SYNC_BAD_REQUEST") {
      return "Requete Spotify invalide. Reconnecte Spotify puis reessaie.";
    }
    if (code.startsWith("SPOTIFY_SYNC_FETCH_FAILED_HTTP_")) {
      return `Echec Spotify (${code.replace("SPOTIFY_SYNC_FETCH_FAILED_HTTP_", "HTTP ")}). Reessaie dans quelques secondes.`;
    }
    return `Erreur sync Spotify: ${code || "UNKNOWN_ERROR"}`;
  })();

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const payload = event.data as { source?: string; ok?: boolean } | null;
      if (!payload || payload.source !== "kwizik-music-oauth") return;
      if (payload.ok === true) {
        void providerLinksQuery.refetch();
        void librarySyncStatusQuery.refetch();
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [librarySyncStatusQuery, providerLinksQuery]);

  const connectMutation = useMutation({
    mutationFn: async (provider: LinkableProvider) => {
      const payload = await getMusicProviderConnectUrl({
        provider,
        returnTo: window.location.href,
      });
      const popup = window.open(payload.authorizeUrl, "kwizik-music-oauth", "width=640,height=760");
      if (!popup) {
        window.location.assign(payload.authorizeUrl);
      }
      return payload;
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async (provider: LinkableProvider) => disconnectMusicProvider({ provider }),
    onSuccess: async () => {
      await providerLinksQuery.refetch();
      await librarySyncStatusQuery.refetch();
    },
  });

  const librarySyncMutation = useMutation({
    mutationFn: queueMySpotifyLibrarySync,
    onSuccess: async () => {
      await librarySyncStatusQuery.refetch();
    },
  });

  const signOutMutation = useMutation({
    mutationFn: signOutAccount,
    onSuccess: async () => {
      clearAccount();
      await queryClient.invalidateQueries({ queryKey: ["auth-session"] });
      await queryClient.invalidateQueries({ queryKey: ["music-provider-links"] });
      navigate({ to: "/" });
    },
  });

  const user = sessionQuery.data?.user ?? null;

  return (
    <section className="single-panel">
      <article className="panel-card">
        <h2 className="panel-title">Profil & connexions</h2>
        <p className="panel-copy">
          Lie tes comptes musicaux pour contribuer tes bibliothèques personnelles dans les rooms.
        </p>

        {!sessionQuery.isPending && !user && (
          <div className="panel-form">
            <p className="status">Tu dois être connecté pour gérer tes connexions musicales.</p>
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
              Connecté: <strong>{user.name}</strong> ({user.email})
            </p>

            {(["spotify", "deezer"] as const).map((provider) => {
              const status = (providerLinksQuery.data?.providers?.[provider]?.status ??
                "not_linked") as ProviderLinkStatus;
              const statusMeta = providerStatusMeta(status);
              const busy =
                connectMutation.isPending ||
                disconnectMutation.isPending ||
                librarySyncMutation.isPending;
              return (
                <div key={provider} className="provider-link-card">
                  <div className="provider-link-head">
                    <div>
                      <p className="kicker">{providerLabel(provider)}</p>
                      <h3>{providerLabel(provider)} Music</h3>
                    </div>
                    <span className={`provider-badge ${statusMeta.tone}`}>{statusMeta.label}</span>
                  </div>
                  <p className="status">{statusMeta.description}</p>
                  <div className="waiting-actions">
                    {status === "linked" ? (
                      <button
                        className="ghost-btn danger-btn"
                        type="button"
                        disabled={busy}
                        onClick={() => disconnectMutation.mutate(provider)}
                      >
                        Deconnecter {providerLabel(provider)}
                      </button>
                    ) : (
                      <button
                        className="solid-btn"
                        type="button"
                        disabled={busy}
                        onClick={() => connectMutation.mutate(provider)}
                      >
                        Connecter {providerLabel(provider)}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {spotifyLinked && (
              <div className="provider-link-card">
                <div className="provider-link-head">
                  <div>
                    <p className="kicker">Spotify</p>
                    <h3>Bibliotheque likes</h3>
                  </div>
                  <span className="provider-badge connected">Action manuelle</span>
                </div>
                <p className="status">
                  Etat sync: <strong>{librarySyncStatusQuery.data?.status ?? "idle"}</strong>
                  {typeof librarySyncStatusQuery.data?.progress === "number"
                    ? ` (${librarySyncStatusQuery.data.progress}%)`
                    : ""}
                  {typeof librarySyncStatusQuery.data?.totalTracks === "number"
                    ? ` · ${librarySyncStatusQuery.data.totalTracks} titres`
                    : ""}
                </p>
                <div className="waiting-actions">
                  <button
                    className="solid-btn"
                    type="button"
                    disabled={librarySyncMutation.isPending}
                    onClick={() => librarySyncMutation.mutate()}
                  >
                    {librarySyncMutation.isPending ? "Synchronisation..." : "Synchroniser mes likes"}
                  </button>
                </div>
              </div>
            )}

            <div className="waiting-actions">
              <button
                className="ghost-btn danger-btn"
                type="button"
                disabled={signOutMutation.isPending || librarySyncMutation.isPending}
                onClick={() => signOutMutation.mutate()}
              >
                {signOutMutation.isPending ? "Déconnexion..." : "Se déconnecter"}
              </button>
              <Link className="ghost-btn" to="/">
                Retour accueil
              </Link>
            </div>
          </div>
        )}

        <p
          className={
            (connectMutation.isError ||
            disconnectMutation.isError ||
            signOutMutation.isError ||
            librarySyncMutation.isError ||
            librarySyncStatusQuery.data?.status === "error")
              ? "status error"
              : "status"
          }
        >
          {connectMutation.isError && "Impossible de lancer la connexion OAuth."}
          {disconnectMutation.isError && "Impossible de déconnecter ce provider."}
          {signOutMutation.isError && "Déconnexion impossible pour le moment."}
          {librarySyncMutation.isError && "Impossible de lancer la synchronisation Spotify."}
          {!librarySyncMutation.isError &&
            librarySyncStatusQuery.data?.status === "error" &&
            syncErrorMessage}
        </p>
      </article>
    </section>
  );
}
