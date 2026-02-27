import { Elysia } from "elysia";
import { logEvent } from "../../lib/logger";
import { animeCatalogCache } from "../../services/AnimeCatalogCache";
import { unifiedMusicSearch } from "../../services/MusicAggregator";

function emptyProviderResults() {
  return {
    spotify: [],
    deezer: [],
    "apple-music": [],
    tidal: [],
    youtube: [],
  };
}

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
    const domain = typeof query.domain === "string" ? query.domain.trim().toLowerCase() : "";

    if (!q) {
      set.status = 400;
      return { error: "MISSING_QUERY" };
    }

    if (domain === "anime") {
      try {
        const result = await animeCatalogCache.search(q, limit);
        return {
          domain: "anime" as const,
          query: q,
          limit: Math.max(1, Math.min(limit, 50)),
          suggestions: result.suggestions,
          cacheState: result.cacheState,
        };
      } catch (error) {
        logEvent("warn", "music_search_anime_failed", {
          query: q,
          limit,
          error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
        });
        return {
          domain: "anime" as const,
          query: q,
          limit: Math.max(1, Math.min(limit, 50)),
          suggestions: [],
          cacheState: "error" as const,
        };
      }
    }

    try {
      const result = await unifiedMusicSearch(q, limit);
      if (Object.keys(result.providerErrors).length > 0) {
        logEvent("warn", "music_search_provider_errors", {
          query: q,
          limit,
          providerErrors: result.providerErrors,
        });
      }
      return result;
    } catch (error) {
      logEvent("warn", "music_search_failed", {
        query: q,
        limit,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      });
      return {
        query: q,
        limit: Math.max(1, Math.min(limit, 50)),
        fallback: [],
        results: emptyProviderResults(),
        providerErrors: {},
      };
    }
  },
);
