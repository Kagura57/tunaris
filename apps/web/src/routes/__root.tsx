import { Link, Outlet } from "@tanstack/react-router";

export function RootLayout() {
  return (
    <main className="app-shell">
      <header className="app-header screen-enter">
        <h1 className="brand">Tunaris</h1>
        <p className="brand-tag">Arcade Music Quiz Party Engine</p>
        <nav className="nav-links">
          <Link className="nav-link" to="/">
            Accueil
          </Link>
          <Link className="nav-link" to="/join">
            Rejoindre
          </Link>
        </nav>
      </header>
      <Outlet />
    </main>
  );
}
