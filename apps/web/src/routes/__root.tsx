import { Link, Outlet } from "@tanstack/react-router";

export function RootLayout() {
  return (
    <main
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        margin: "24px auto",
        maxWidth: 760,
        padding: "0 16px",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <h1 style={{ margin: 0 }}>Tunaris</h1>
        <nav style={{ display: "flex", gap: 12 }}>
          <Link to="/">Accueil</Link>
          <Link to="/join">Rejoindre</Link>
        </nav>
      </header>
      <Outlet />
    </main>
  );
}
