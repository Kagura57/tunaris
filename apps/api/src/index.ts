import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { quizRoutes } from "./routes/quiz";
import { roomRoutes } from "./routes/room";

const API_PORT = 3001;

export const app = new Elysia()
  .use(
    cors({
      origin: true,
      methods: ["GET", "POST", "PATCH", "OPTIONS"],
      allowedHeaders: ["content-type", "authorization"],
    }),
  )
  .use(quizRoutes)
  .use(roomRoutes);

if (import.meta.main) {
  app.listen(API_PORT);
  console.log(`Tunaris API running on http://127.0.0.1:${API_PORT}`);
}
