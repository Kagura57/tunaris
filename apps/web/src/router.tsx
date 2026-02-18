import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { RootLayout } from "./routes/__root";
import { HomePage } from "./routes/index";
import { JoinPage } from "./routes/join";
import { LobbyPage } from "./routes/lobby/$roomCode";
import { PlayPage } from "./routes/play/$roomCode";
import { ResultsPage } from "./routes/results/$roomCode";

const rootRoute = createRootRoute({
  component: RootLayout,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/join",
  component: JoinPage,
});

const lobbyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lobby/$roomCode",
  component: LobbyPage,
});

const playRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/play/$roomCode",
  component: PlayPage,
});

const resultsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/results/$roomCode",
  component: ResultsPage,
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  joinRoute,
  lobbyRoute,
  playRoute,
  resultsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
