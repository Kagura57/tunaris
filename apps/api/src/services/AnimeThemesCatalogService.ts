import { pool } from "../db/client";
import { logEvent } from "../lib/logger";

type AnimeThemesVideo = {
  basename?: string;
  filename?: string;
  link?: string;
  resolution?: number;
  nc?: boolean;
};

type AnimeThemesEntry = {
  videos?: AnimeThemesVideo[];
};

type AnimeTheme = {
  type?: string;
  sequence?: number;
  animethemeentries?: AnimeThemesEntry[];
};

type AnimeThemesAnime = {
  id?: number;
  name?: string;
  animethemes?: AnimeTheme[];
};

type AnimeThemesListPayload = {
  anime?: AnimeThemesAnime[];
  links?: {
    next?: string | null;
  };
};

function isDbEnabled() {
  const value = process.env.DATABASE_URL;
  return typeof value === "string" && value.trim().length > 0;
}

function toThemeType(raw: string | null | undefined) {
  const upper = raw?.toUpperCase() ?? "";
  if (upper.startsWith("OP")) return "OP" as const;
  if (upper.startsWith("ED")) return "ED" as const;
  return null;
}

function clampResolution(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function safeVideoKey(input: {
  animeId: string;
  themeType: "OP" | "ED";
  sequence: number | null;
  basename: string | null;
  filename: string | null;
  index: number;
}) {
  if (input.basename && input.basename.trim().length > 0) return input.basename.trim();
  if (input.filename && input.filename.trim().length > 0) return input.filename.trim();
  const seq = input.sequence ?? 0;
  return `${input.animeId}-${input.themeType}${seq}-v${input.index}`;
}

export function normalizeAnimeAlias(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchAnimeThemesPage(url: string) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`ANIMETHEMES_HTTP_${response.status}`);
  }
  return (await response.json()) as AnimeThemesListPayload;
}

async function upsertAnime(input: { animeId: string; title: string }) {
  const result = await pool.query<{ id: number }>(
    `
      insert into anime_catalog_anime
        (animethemes_anime_id, title_romaji, title_english, title_native, searchable_romaji, is_active, updated_at)
      values
        ($1, $2, null, null, $3, true, now())
      on conflict (animethemes_anime_id)
      do update set
        title_romaji = excluded.title_romaji,
        searchable_romaji = excluded.searchable_romaji,
        is_active = true,
        updated_at = now()
      returning id
    `,
    [input.animeId, input.title, normalizeAnimeAlias(input.title)],
  );
  const row = result.rows[0];
  if (!row) throw new Error("ANIME_UPSERT_FAILED");
  return row.id;
}

async function upsertCanonicalAlias(input: { animeId: number; title: string }) {
  await pool.query(
    `
      insert into anime_catalog_alias
        (anime_id, alias, normalized_alias, alias_type)
      values
        ($1, $2, $3, 'canonical')
      on conflict (anime_id, normalized_alias)
      do update set
        alias = excluded.alias,
        alias_type = excluded.alias_type
    `,
    [input.animeId, input.title, normalizeAnimeAlias(input.title)],
  );
}

async function upsertThemeVideo(input: {
  animeId: number;
  videoKey: string;
  themeType: "OP" | "ED";
  themeNumber: number | null;
  webmUrl: string;
  resolution: number | null;
  isCreditless: boolean;
}) {
  await pool.query(
    `
      insert into anime_theme_videos
        (anime_id, theme_type, theme_number, video_key, webm_url, resolution, is_creditless, is_playable, updated_at)
      values
        ($1, $2, $3, $4, $5, $6, $7, true, now())
      on conflict (video_key)
      do update set
        anime_id = excluded.anime_id,
        theme_type = excluded.theme_type,
        theme_number = excluded.theme_number,
        webm_url = excluded.webm_url,
        resolution = excluded.resolution,
        is_creditless = excluded.is_creditless,
        is_playable = true,
        updated_at = now()
    `,
    [
      input.animeId,
      input.themeType,
      input.themeNumber,
      input.videoKey,
      input.webmUrl,
      input.resolution,
      input.isCreditless,
    ],
  );
}

export async function refreshAnimeThemesCatalog(input?: { maxPages?: number }) {
  const maxPages = Math.max(1, Math.min(input?.maxPages ?? 40, 200));
  if (!isDbEnabled()) {
    return {
      pageCount: 0,
      animeCount: 0,
      aliasCount: 0,
      videoCount: 0,
    };
  }

  let pageUrl: string | null =
    "https://api.animethemes.moe/anime?include=animethemes.animethemeentries.videos&page[size]=100";
  let pageCount = 0;
  let animeCount = 0;
  let aliasCount = 0;
  let videoCount = 0;

  while (pageUrl && pageCount < maxPages) {
    const payload = await fetchAnimeThemesPage(pageUrl);
    pageCount += 1;
    const animeList = payload.anime ?? [];

    for (const anime of animeList) {
      const animeIdRaw = anime.id;
      const title = anime.name?.trim() ?? "";
      if (typeof animeIdRaw !== "number" || !Number.isFinite(animeIdRaw) || !title) continue;

      const animeId = await upsertAnime({
        animeId: String(animeIdRaw),
        title,
      });
      animeCount += 1;

      await upsertCanonicalAlias({
        animeId,
        title,
      });
      aliasCount += 1;

      const themes = anime.animethemes ?? [];
      for (const theme of themes) {
        const themeType = toThemeType(theme.type);
        if (!themeType) continue;
        const themeNumber =
          typeof theme.sequence === "number" && Number.isFinite(theme.sequence)
            ? Math.max(1, Math.round(theme.sequence))
            : null;
        const entries = theme.animethemeentries ?? [];
        let localIndex = 0;
        for (const entry of entries) {
          const videos = entry.videos ?? [];
          for (const video of videos) {
            localIndex += 1;
            const webmUrl = video.link?.trim() ?? "";
            if (!webmUrl) continue;
            const key = safeVideoKey({
              animeId: String(animeIdRaw),
              themeType,
              sequence: themeNumber,
              basename: video.basename ?? null,
              filename: video.filename ?? null,
              index: localIndex,
            });

            await upsertThemeVideo({
              animeId,
              themeType,
              themeNumber,
              videoKey: key,
              webmUrl,
              resolution: clampResolution(video.resolution),
              isCreditless: Boolean(video.nc),
            });
            videoCount += 1;
          }
        }
      }
    }

    const nextPage = payload.links?.next?.trim() ?? "";
    pageUrl = nextPage.length > 0 ? nextPage : null;
  }

  logEvent("info", "animethemes_catalog_refresh_completed", {
    pageCount,
    animeCount,
    aliasCount,
    videoCount,
    maxPages,
  });

  return {
    pageCount,
    animeCount,
    aliasCount,
    videoCount,
  };
}
