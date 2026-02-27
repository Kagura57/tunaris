import { logEvent } from "../lib/logger";
import { fetchJsonWithTimeout } from "../routes/music/http";

type AniListMediaTitle = {
  romaji?: string | null;
  english?: string | null;
  native?: string | null;
};

type AniListSearchPayload = {
  data?: {
    Page?: {
      media?: Array<{
        title?: AniListMediaTitle | null;
        synonyms?: string[] | null;
      }> | null;
    };
  };
};

type QueryCacheEntry = {
  suggestions: string[];
  expiresAt: number;
  staleAt: number;
  refreshJob: Promise<void> | null;
};

const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";
const SEARCH_QUERY = `
query ($search: String, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(type: ANIME, search: $search, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
      title {
        romaji
        english
        native
      }
      synonyms
    }
  }
}
`;

function normalizeQuery(value: string) {
  return value.trim().toLowerCase();
}

function readLimit(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), 50));
}

function pickCanonicalTitle(title: AniListMediaTitle | null | undefined) {
  const candidates = [title?.romaji, title?.english, title?.native];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed && trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function dedupeSuggestions(input: string[]) {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const value = raw.trim();
    if (value.length <= 0) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

export class AnimeCatalogCache {
  private readonly queryCache = new Map<string, QueryCacheEntry>();
  private readonly queryTtlMs: number;
  private readonly staleWindowMs: number;
  private readonly maxCacheKeys: number;

  constructor(config?: {
    queryTtlMs?: number;
    staleWindowMs?: number;
    maxCacheKeys?: number;
  }) {
    this.queryTtlMs = Math.max(60_000, config?.queryTtlMs ?? 6 * 60 * 60_000);
    this.staleWindowMs = Math.max(10_000, config?.staleWindowMs ?? 10 * 60_000);
    this.maxCacheKeys = Math.max(50, config?.maxCacheKeys ?? 2_000);
  }

  private touchCacheEntry(key: string, entry: QueryCacheEntry) {
    this.queryCache.delete(key);
    this.queryCache.set(key, entry);
    if (this.queryCache.size <= this.maxCacheKeys) return;
    const oldest = this.queryCache.keys().next().value;
    if (oldest) {
      this.queryCache.delete(oldest);
    }
  }

  private async fetchFromAniList(query: string, limit: number) {
    const safeLimit = readLimit(limit, 12);
    const perPage = Math.max(20, Math.min(50, safeLimit * 3));
    const payload = (await fetchJsonWithTimeout(
      ANILIST_GRAPHQL_URL,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: SEARCH_QUERY,
          variables: {
            search: query,
            perPage,
          },
        }),
      },
      {
        timeoutMs: 7_000,
        retries: 1,
        retryDelayMs: 250,
        context: {
          provider: "anilist",
          route: "search",
        },
      },
    )) as AniListSearchPayload | null;

    const media = payload?.data?.Page?.media ?? [];
    const suggestions: string[] = [];
    for (const item of media) {
      const canonical = pickCanonicalTitle(item.title);
      if (canonical) {
        suggestions.push(canonical);
      }
      const aliases = Array.isArray(item.synonyms) ? item.synonyms : [];
      for (const alias of aliases) {
        suggestions.push(alias);
      }
    }
    return dedupeSuggestions(suggestions).slice(0, safeLimit);
  }

  async search(query: string, limit: number) {
    const normalizedQuery = normalizeQuery(query);
    const safeLimit = readLimit(limit, 12);
    if (normalizedQuery.length < 2) {
      return {
        suggestions: [] as string[],
        cacheState: "too_short" as const,
      };
    }

    const existing = this.queryCache.get(normalizedQuery);
    if (existing && existing.expiresAt > Date.now()) {
      this.touchCacheEntry(normalizedQuery, existing);
      return {
        suggestions: existing.suggestions.slice(0, safeLimit),
        cacheState: "hit" as const,
      };
    }

    if (existing && existing.staleAt > Date.now()) {
      if (!existing.refreshJob) {
        existing.refreshJob = this.fetchFromAniList(normalizedQuery, safeLimit)
          .then((suggestions) => {
            const refreshed: QueryCacheEntry = {
              suggestions,
              expiresAt: Date.now() + this.queryTtlMs,
              staleAt: Date.now() + this.queryTtlMs + this.staleWindowMs,
              refreshJob: null,
            };
            this.touchCacheEntry(normalizedQuery, refreshed);
          })
          .catch((error) => {
            logEvent("warn", "anime_catalog_refresh_failed", {
              query: normalizedQuery,
              error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
            });
            const next = this.queryCache.get(normalizedQuery);
            if (next) {
              next.refreshJob = null;
              this.touchCacheEntry(normalizedQuery, next);
            }
          });
      }
      this.touchCacheEntry(normalizedQuery, existing);
      return {
        suggestions: existing.suggestions.slice(0, safeLimit),
        cacheState: "stale" as const,
      };
    }

    const suggestions = await this.fetchFromAniList(normalizedQuery, safeLimit);
    const entry: QueryCacheEntry = {
      suggestions,
      expiresAt: Date.now() + this.queryTtlMs,
      staleAt: Date.now() + this.queryTtlMs + this.staleWindowMs,
      refreshJob: null,
    };
    this.touchCacheEntry(normalizedQuery, entry);
    return {
      suggestions: suggestions.slice(0, safeLimit),
      cacheState: "miss" as const,
    };
  }
}

export const animeCatalogCache = new AnimeCatalogCache();

