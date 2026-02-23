import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { getAuthSession, signOutAccount } from "../lib/api";
import { useGameStore } from "../stores/gameStore";

export function RootLayout() {
  const clearSession = useGameStore((state) => state.clearSession);
  const account = useGameStore((state) => state.account);
  const setAccount = useGameStore((state) => state.setAccount);
  const clearAccount = useGameStore((state) => state.clearAccount);
  const queryClient = useQueryClient();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const wasInRoomRef = useRef(false);
  const isRoomRoute = /^\/room\/[^/]+\/(play|view)$/.test(pathname);

  const authSessionQuery = useQuery({
    queryKey: ["auth-session"],
    queryFn: getAuthSession,
    retry: false,
    staleTime: 60_000,
  });

  const signOutMutation = useMutation({
    mutationFn: signOutAccount,
    onSuccess: async () => {
      clearAccount();
      await queryClient.invalidateQueries({ queryKey: ["auth-session"] });
      await queryClient.invalidateQueries({ queryKey: ["music-provider-links"] });
    },
  });

  useEffect(() => {
    if (!isRoomRoute && wasInRoomRef.current) {
      clearSession();
    }
    wasInRoomRef.current = isRoomRoute;
  }, [clearSession, isRoomRoute]);

  useEffect(() => {
    if (!authSessionQuery.isSuccess) return;
    if (!authSessionQuery.data?.user) {
      clearAccount();
      return;
    }

    setAccount({
      userId: authSessionQuery.data.user.id,
      name: authSessionQuery.data.user.name,
      email: authSessionQuery.data.user.email,
    });
  }, [authSessionQuery.data, authSessionQuery.isSuccess, clearAccount, setAccount]);

  if (isRoomRoute) {
    return (
      <main className="game-shell">
        <header className="room-topbar">
          <Link className="brand" to="/">
            Tunaris
          </Link>
          <Link className="ghost-btn" to="/">
            Accueil
          </Link>
        </header>
        <Outlet />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/">
          Tunaris
        </Link>
        <p className="brand-subtitle">Live Blindtest Arena</p>
        <p className="topbar-meta">Crée une room, rejoins en un code, et lance la partie en direct.</p>
        <nav className="topbar-nav">
          <Link className="ghost-btn" to="/">
            Accueil
          </Link>
          {account.userId ? (
            <>
              <Link className="ghost-btn" to="/settings">
                {account.name ?? "Paramètres"}
              </Link>
              <button
                className="ghost-btn"
                type="button"
                disabled={signOutMutation.isPending}
                onClick={() => signOutMutation.mutate()}
              >
                {signOutMutation.isPending ? "Déconnexion..." : "Déconnexion"}
              </button>
            </>
          ) : (
            <Link className="solid-btn" to="/auth">
              Connexion
            </Link>
          )}
        </nav>
      </header>
      <Outlet />
    </main>
  );
}
