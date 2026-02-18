import { Elysia } from "elysia";

export const quizRoutes = new Elysia({ prefix: "/quiz" })
  .post("/create", () => ({ roomCode: "ABCD12" }))
  .post("/join", () => ({ ok: true, playerId: "p1" }))
  .post("/start", () => ({ ok: true, state: "countdown" as const }))
  .post("/answer", () => ({ accepted: true }))
  .get("/results/:roomCode", ({ params }) => ({ roomCode: params.roomCode, ranking: [] }));
