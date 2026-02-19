import { Elysia } from "elysia";
import { fetchAniListUserAnimeTitles } from "./anilist";
import { searchDeezerPlaylists } from "./deezer";
import {
  fetchSpotifyPlaylistCategories,
  fetchSpotifyPlaylistsForCategory,
  fetchSpotifyPopularPlaylists,
  searchSpotifyPlaylists,
} from "./spotify";
import { parseTrackSource, resolveTrackPoolFromSource } from "../../services/TrackSourceResolver";

function parseLimit(raw: string | undefined, fallback: number) {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, parsed);
}

function parseUsers(raw: string | undefined) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

type UnifiedPlaylistOption = {
  provider: "spotify" | "deezer";
  id: string;
  name: string;
  description: string;
  imageUrl: string | null;
  externalUrl: string;
  owner: string | null;
  trackCount: number | null;
  sourceQuery: string;
};

function playlistWeight(item: UnifiedPlaylistOption) {
  let score = item.trackCount ?? 0;
  const owner = (item.owner ?? "").toLowerCase();
  const name = item.name.toLowerCase();
  if (item.provider === "spotify" && owner.includes("spotify")) score += 300;
  if (item.provider === "deezer" && owner.includes("deezer")) score += 120;
  if (name.includes("top") || name.includes("hits") || name.includes("viral")) score += 40;
  if (item.imageUrl) score += 15;
  return score;
}

export const musicSourceRoutes = new Elysia({ prefix: "/music" })
  .get("/source/resolve", async ({ query, set }) => {
    const source = typeof query.source === "string" ? query.source.trim() : "";
    if (!source) {
      set.status = 400;
      return { error: "MISSING_SOURCE" };
    }

    const size = parseLimit(typeof query.size === "string" ? query.size : undefined, 12);
    const parsed = parseTrackSource(source);
    const tracks = await resolveTrackPoolFromSource({
      categoryQuery: source,
      size,
    });
    const previewCount = tracks.filter(
      (track) => typeof track.previewUrl === "string" && track.previewUrl.trim().length > 0,
    ).length;

    return {
      ok: true as const,
      source,
      parsed,
      count: tracks.length,
      previewCount,
      withoutPreviewCount: Math.max(0, tracks.length - previewCount),
      tracks,
    };
  })
  .get("/spotify/categories", async ({ query }) => {
    const limit = parseLimit(typeof query.limit === "string" ? query.limit : undefined, 24);
    return {
      ok: true as const,
      categories: await fetchSpotifyPlaylistCategories(limit),
    };
  })
  .get("/spotify/playlists", async ({ query }) => {
    const limit = parseLimit(typeof query.limit === "string" ? query.limit : undefined, 20);
    const categoryId = typeof query.category === "string" ? query.category.trim() : "";
    const search = typeof query.q === "string" ? query.q.trim() : "";

    if (search.length > 0) {
      const playlists = await searchSpotifyPlaylists(search, limit);
      return {
        ok: true as const,
        source: "search",
        search,
        playlists,
      };
    }

    if (categoryId.length > 0) {
      const playlists = await fetchSpotifyPlaylistsForCategory(categoryId, limit);
      return {
        ok: true as const,
        source: "category",
        category: categoryId,
        playlists,
      };
    }

    const playlists = await fetchSpotifyPopularPlaylists(limit);
    return {
      ok: true as const,
      source: "popular",
      playlists,
    };
  })
  .get("/playlists/search", async ({ query, set }) => {
    const limit = parseLimit(typeof query.limit === "string" ? query.limit : undefined, 24);
    const raw = typeof query.q === "string" ? query.q.trim() : "";
    if (raw.length < 2) {
      set.status = 400;
      return { error: "MISSING_QUERY" };
    }

    const [spotify, deezer] = await Promise.all([
      searchSpotifyPlaylists(raw, limit),
      searchDeezerPlaylists(raw, limit),
    ]);

    const merged: UnifiedPlaylistOption[] = [
      ...spotify.map((item) => ({
        provider: "spotify" as const,
        id: item.id,
        name: item.name,
        description: item.description,
        imageUrl: item.imageUrl,
        externalUrl: item.externalUrl,
        owner: item.owner,
        trackCount: item.trackCount,
        sourceQuery: `spotify:playlist:${item.id}`,
      })),
      ...deezer.map((item) => ({
        provider: "deezer" as const,
        id: item.id,
        name: item.name,
        description: item.description,
        imageUrl: item.imageUrl,
        externalUrl: item.externalUrl,
        owner: item.owner,
        trackCount: item.trackCount,
        sourceQuery: `deezer:playlist:${item.id}`,
      })),
    ];

    const deduped: UnifiedPlaylistOption[] = [];
    const seen = new Set<string>();
    for (const playlist of merged.sort((a, b) => playlistWeight(b) - playlistWeight(a))) {
      const key = `${playlist.provider}:${playlist.id}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(playlist);
      if (deduped.length >= limit) break;
    }

    return {
      ok: true as const,
      q: raw,
      playlists: deduped,
    };
  })
  .get("/anilist/titles", async ({ query, set }) => {
    const users = parseUsers(typeof query.users === "string" ? query.users : undefined).slice(0, 8);
    if (users.length === 0) {
      set.status = 400;
      return { error: "MISSING_USERS" };
    }

    const limit = parseLimit(typeof query.limit === "string" ? query.limit : undefined, 60);
    const byUser = await Promise.all(
      users.map(async (user) => ({
        user,
        titles: await fetchAniListUserAnimeTitles(user, limit),
      })),
    );

    return {
      ok: true as const,
      users,
      byUser,
    };
  });
