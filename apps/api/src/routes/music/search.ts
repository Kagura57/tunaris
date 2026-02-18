import { Elysia } from "elysia";
import { unifiedMusicSearch } from "../../services/MusicAggregator";

function parseLimit(raw: string | undefined) {
  if (!raw) return 10;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 10;
}

export const musicSearchRoute = new Elysia({ prefix: "/music" }).get(
  "/search",
  async ({ query, set }) => {
    const q = typeof query.q === "string" ? query.q.trim() : "";
    const limit = parseLimit(typeof query.limit === "string" ? query.limit : undefined);

    if (!q) {
      set.status = 400;
      return { error: "MISSING_QUERY" };
    }

    return unifiedMusicSearch(q, limit);
  },
);
