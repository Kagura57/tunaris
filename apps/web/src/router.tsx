import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { RootLayout } from "./routes/__root";
import { HomePage } from "./routes/index";
import { JoinPage } from "./routes/join";
import { RoomPlayPage } from "./routes/room/$roomCode/play";
import { RoomViewPage } from "./routes/room/$roomCode/view";

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

const roomPlayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/room/$roomCode/play",
  component: RoomPlayPage,
});

const roomViewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/room/$roomCode/view",
  component: RoomViewPage,
});

const routeTree = rootRoute.addChildren([homeRoute, joinRoute, roomPlayRoute, roomViewRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
