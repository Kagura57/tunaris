import { logEvent } from "../../lib/logger";
import { fetchJsonWithTimeout } from "./http";

type AnimeThemesVideo = {
  id?: number | null;
  link?: string | null;
  resolution?: number | null;
  nc?: boolean | null;
};

type AnimeThemesEntry = {
  videos?: AnimeThemesVideo[] | null;
};

type AnimeTheme = {
  sequence?: number | null;
  type?: string | null;
  slug?: string | null;
  animethemeentries?: AnimeThemesEntry[] | null;
};

type AnimeThemesAnime = {
  name?: string | null;
  animethemes?: AnimeTheme[] | null;
};

type AnimeThemesPayload = {
  anime?: AnimeThemesAnime[] | null;
};

export type ResolvedAnimeThemeVideo = {
  trackId: string;
  animeName: string;
  themeLabel: string;
  sourceUrl: string;
  resolution: number;
  creditless: boolean;
};

type CacheEntry = {
  expiresAt: number;
  value: ResolvedAnimeThemeVideo | null;
};

const ANIMETHEMES_API_URL = "https://api.animethemes.moe/anime";
const ANIMETHEMES_CACHE_TTL_MS = 6 * 60 * 60_000;
const ANIMETHEMES_QUERY_CACHE = new Map<string, CacheEntry>();

function normalizeQuery(value: string) {
  return value.trim().toLowerCase();
}

function cacheGet(query: string) {
  const key = normalizeQuery(query);
  if (!key) return { hit: false as const, value: null as ResolvedAnimeThemeVideo | null };
  const existing = ANIMETHEMES_QUERY_CACHE.get(key);
  if (!existing) return { hit: false as const, value: null as ResolvedAnimeThemeVideo | null };
  if (existing.expiresAt <= Date.now()) {
    ANIMETHEMES_QUERY_CACHE.delete(key);
    return { hit: false as const, value: null as ResolvedAnimeThemeVideo | null };
  }
  return { hit: true as const, value: existing.value };
}

function cacheSet(query: string, value: ResolvedAnimeThemeVideo | null) {
  const key = normalizeQuery(query);
  if (!key) return;
  ANIMETHEMES_QUERY_CACHE.set(key, {
    value,
    expiresAt: Date.now() + ANIMETHEMES_CACHE_TTL_MS,
  });
  if (ANIMETHEMES_QUERY_CACHE.size <= 2_000) return;
  const oldest = ANIMETHEMES_QUERY_CACHE.keys().next().value;
  if (oldest) {
    ANIMETHEMES_QUERY_CACHE.delete(oldest);
  }
}

function asText(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function asNumber(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

function videoScore(input: {
  type: string;
  sequence: number;
  resolution: number;
  creditless: boolean;
}) {
  const typeBonus = input.type === "OP" ? 6_000 : input.type === "ED" ? 5_000 : 4_000;
  const creditlessBonus = input.creditless ? 1_200 : 0;
  const sequencePenalty = Math.max(0, input.sequence) * 10;
  return typeBonus + creditlessBonus + input.resolution - sequencePenalty;
}

function pickBestVideo(payload: AnimeThemesPayload): ResolvedAnimeThemeVideo | null {
  const anime = Array.isArray(payload.anime) ? payload.anime[0] : null;
  if (!anime) return null;
  const animeName = asText(anime.name) || "Unknown anime";
  const themes = Array.isArray(anime.animethemes) ? anime.animethemes : [];

  let selected:
    | {
        score: number;
        result: ResolvedAnimeThemeVideo;
      }
    | null = null;

  for (const theme of themes) {
    const type = asText(theme.type).toUpperCase();
    const slug = asText(theme.slug);
    const sequence = asNumber(theme.sequence, 1);
    const entries = Array.isArray(theme.animethemeentries) ? theme.animethemeentries : [];

    for (const entry of entries) {
      const videos = Array.isArray(entry.videos) ? entry.videos : [];
      for (const video of videos) {
        const link = asText(video.link);
        if (!link) continue;
        if (!link.toLowerCase().endsWith(".webm")) continue;

        const resolution = Math.max(0, asNumber(video.resolution, 0));
        const creditless = video.nc === true;
        const score = videoScore({
          type,
          sequence,
          resolution,
          creditless,
        });
        if (selected && selected.score >= score) continue;

        const idRaw = video.id;
        const trackId = idRaw !== null && idRaw !== undefined ? String(idRaw) : `${slug || type || "theme"}:${sequence}`;
        const themeLabel = slug || `${type || "TH"}${sequence > 0 ? sequence : ""}`;
        selected = {
          score,
          result: {
            trackId,
            animeName,
            themeLabel,
            sourceUrl: link,
            resolution,
            creditless,
          },
        };
      }
    }
  }

  return selected?.result ?? null;
}

async function requestAnimeThemesByName(name: string): Promise<ResolvedAnimeThemeVideo | null> {
  const cached = cacheGet(name);
  if (cached.hit) {
    return cached.value;
  }

  const url = new URL(ANIMETHEMES_API_URL);
  url.searchParams.set("filter[name]", name);
  url.searchParams.set("include", "animethemes.animethemeentries.videos");
  url.searchParams.set("page[size]", "1");

  const payload = (await fetchJsonWithTimeout(
    url.toString(),
    {},
    {
      timeoutMs: 7_000,
      retries: 1,
      retryDelayMs: 250,
      context: {
        provider: "animethemes",
        route: "anime",
      },
    },
  )) as AnimeThemesPayload | null;

  const resolved = payload ? pickBestVideo(payload) : null;
  cacheSet(name, resolved);
  return resolved;
}

function dedupeSearchTerms(canonicalTitle: string, aliases: string[]) {
  const values = [canonicalTitle, ...aliases];
  const output: string[] = [];
  const seen = new Set<string>();

  for (const raw of values) {
    const trimmed = raw.trim();
    if (trimmed.length <= 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(trimmed);
    if (output.length >= 8) break;
  }

  return output;
}

export async function resolveAnimeThemeVideo(input: {
  canonicalTitle: string;
  aliases: string[];
}): Promise<ResolvedAnimeThemeVideo | null> {
  const terms = dedupeSearchTerms(input.canonicalTitle, input.aliases);
  if (terms.length <= 0) return null;

  for (const term of terms) {
    try {
      const resolved = await requestAnimeThemesByName(term);
      if (!resolved) continue;
      return resolved;
    } catch (error) {
      logEvent("warn", "animethemes_query_failed", {
        query: term,
        canonicalTitle: input.canonicalTitle,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      });
    }
  }

  logEvent("warn", "animethemes_video_not_found", {
    canonicalTitle: input.canonicalTitle,
    termCount: terms.length,
  });
  return null;
}
