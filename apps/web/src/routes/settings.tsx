import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  disconnectMusicProvider,
  getAuthSession,
  getMusicProviderConnectUrl,
  getMusicProviderLinks,
  signOutAccount,
} from "../lib/api";
import { useGameStore } from "../stores/gameStore";

type LinkableProvider = "spotify" | "deezer";

function providerLabel(provider: LinkableProvider) {
  return provider === "spotify" ? "Spotify" : "Deezer";
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

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const payload = event.data as { source?: string; ok?: boolean } | null;
      if (!payload || payload.source !== "tunaris-music-oauth") return;
      if (payload.ok === true) {
        void providerLinksQuery.refetch();
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [providerLinksQuery]);

  const connectMutation = useMutation({
    mutationFn: async (provider: LinkableProvider) => {
      const payload = await getMusicProviderConnectUrl({
        provider,
        returnTo: window.location.href,
      });
      const popup = window.open(payload.authorizeUrl, "tunaris-music-oauth", "width=640,height=760");
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

            <button
              className="ghost-btn"
              type="button"
              disabled={providerLinksQuery.isFetching}
              onClick={() => providerLinksQuery.refetch()}
            >
              {providerLinksQuery.isFetching ? "Rafraîchissement..." : "Rafraîchir les statuts"}
            </button>

            {(["spotify", "deezer"] as const).map((provider) => {
              const status = providerLinksQuery.data?.providers?.[provider]?.status ?? "not_linked";
              const busy = connectMutation.isPending || disconnectMutation.isPending;
              return (
                <div key={provider} className="waiting-actions">
                  <p className="status">
                    {providerLabel(provider)}: <strong>{status}</strong>
                  </p>
                  {status === "linked" ? (
                    <button
                      className="ghost-btn"
                      type="button"
                      disabled={busy}
                      onClick={() => disconnectMutation.mutate(provider)}
                    >
                      Déconnecter
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
              );
            })}

            <div className="waiting-actions">
              <button
                className="ghost-btn"
                type="button"
                disabled={signOutMutation.isPending}
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

        <p className={(connectMutation.isError || disconnectMutation.isError || signOutMutation.isError) ? "status error" : "status"}>
          {connectMutation.isError && "Impossible de lancer la connexion OAuth."}
          {disconnectMutation.isError && "Impossible de déconnecter ce provider."}
          {signOutMutation.isError && "Déconnexion impossible pour le moment."}
        </p>
      </article>
    </section>
  );
}
