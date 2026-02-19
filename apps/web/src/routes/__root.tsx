import { useEffect, useRef } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useGameStore } from "../stores/gameStore";

export function RootLayout() {
  const clearSession = useGameStore((state) => state.clearSession);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const wasInRoomRef = useRef(false);
  const isRoomRoute = /^\/room\/[^/]+\/(play|view)$/.test(pathname);

  useEffect(() => {
    if (!isRoomRoute && wasInRoomRef.current) {
      clearSession();
    }
    wasInRoomRef.current = isRoomRoute;
  }, [clearSession, isRoomRoute]);

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
        <div className="topbar-meta" />
        <nav className="topbar-nav">
          <Link className="ghost-btn" to="/">
            Accueil
          </Link>
          <Link className="ghost-btn" to="/join">
            Rejoindre
          </Link>
        </nav>
      </header>
      <Outlet />
    </main>
  );
}
