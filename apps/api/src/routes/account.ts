import { Elysia } from "elysia";
import { readSessionFromHeaders } from "../auth/client";
import { matchRepository } from "../repositories/MatchRepository";
import { profileRepository } from "../repositories/ProfileRepository";

async function requireSession(headers: unknown, set: { status: number }) {
  const authContext = await readSessionFromHeaders(headers as Headers);
  if (!authContext) {
    set.status = 401;
    return null;
  }
  return authContext;
}

export const accountRoutes = new Elysia({ prefix: "/account" })
  .get("/me", async ({ headers, set }) => {
    const authContext = await requireSession(headers as unknown, set);
    if (!authContext) {
      return { ok: false, error: "UNAUTHORIZED" };
    }

    const profile = await profileRepository.getProfile(authContext.user.id);

    return {
      ok: true as const,
      session: authContext.session,
      user: authContext.user,
      profile,
    };
  })
  .get("/history", async ({ headers, set }) => {
    const authContext = await requireSession(headers as unknown, set);
    if (!authContext) {
      return { ok: false, error: "UNAUTHORIZED" };
    }

    const [history, profile] = await Promise.all([
      matchRepository.getUserHistory(authContext.user.id),
      profileRepository.getProfile(authContext.user.id),
    ]);

    return {
      ok: true as const,
      user: authContext.user,
      profile,
      history,
    };
  });
