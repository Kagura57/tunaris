import { fetchJsonWithTimeout } from "./http";
import type { MusicTrack } from "../../services/music-types";

type DeezerPayload = {
  data?: Array<{
    id?: number;
    title?: string;
    artist?: { name?: string };
    preview?: string | null;
  }>;
};

type DeezerPlaylistPayload = {
  data?: Array<{
    id?: number;
    title?: string;
    description?: string | null;
    picture_medium?: string | null;
    link?: string | null;
    creator?: {
      name?: string;
    };
    nb_tracks?: number | null;
  }>;
};

export type DeezerPlaylistSummary = {
  provider: "deezer";
  id: string;
  name: string;
  description: string;
  imageUrl: string | null;
  externalUrl: string;
  owner: string | null;
  trackCount: number | null;
};

export async function searchDeezer(query: string, limit = 10): Promise<MusicTrack[]> {
  const enabled = process.env.DEEZER_ENABLED === "true";
  if (!enabled) return [];

  const url = new URL("https://api.deezer.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  const payload = (await fetchJsonWithTimeout(url, {}, {
    context: {
      provider: "deezer",
      query,
    },
  })) as DeezerPayload | null;
  const items = payload?.data ?? [];

  return items
    .map((item) => {
      const id = item.id;
      const title = item.title?.trim();
      const artist = item.artist?.name?.trim();
      if (!id || !title || !artist) return null;
      return {
        provider: "deezer" as const,
        id: String(id),
        title,
        artist,
        previewUrl: item.preview ?? null,
        sourceUrl: `https://www.deezer.com/track/${id}`,
      };
    })
    .filter((value): value is MusicTrack => value !== null);
}

export async function fetchDeezerChartTracks(limit = 20): Promise<MusicTrack[]> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const url = new URL("https://api.deezer.com/chart/0/tracks");
  url.searchParams.set("limit", String(safeLimit));

  const payload = (await fetchJsonWithTimeout(url, {}, {
    context: {
      provider: "deezer",
      route: "chart_tracks",
    },
  })) as DeezerPayload | null;

  return (payload?.data ?? [])
    .map((item) => {
      const id = item.id;
      const title = item.title?.trim();
      const artist = item.artist?.name?.trim();
      if (!id || !title || !artist) return null;
      return {
        provider: "deezer" as const,
        id: String(id),
        title,
        artist,
        previewUrl: item.preview ?? null,
        sourceUrl: `https://www.deezer.com/track/${id}`,
      };
    })
    .filter((value): value is MusicTrack => value !== null)
    .slice(0, safeLimit);
}

export async function fetchDeezerPlaylistTracks(
  playlistId: string,
  limit = 20,
): Promise<MusicTrack[]> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const url = new URL(`https://api.deezer.com/playlist/${encodeURIComponent(playlistId)}/tracks`);
  url.searchParams.set("limit", String(safeLimit));

  const payload = (await fetchJsonWithTimeout(url, {}, {
    context: {
      provider: "deezer",
      route: "playlist_tracks",
      playlistId,
    },
  })) as DeezerPayload | null;

  return (payload?.data ?? [])
    .map((item) => {
      const id = item.id;
      const title = item.title?.trim();
      const artist = item.artist?.name?.trim();
      if (!id || !title || !artist) return null;
      return {
        provider: "deezer" as const,
        id: String(id),
        title,
        artist,
        previewUrl: item.preview ?? null,
        sourceUrl: `https://www.deezer.com/track/${id}`,
      };
    })
    .filter((value): value is MusicTrack => value !== null)
    .slice(0, safeLimit);
}

function toDeezerPlaylistSummary(
  item: DeezerPlaylistPayload["data"] extends Array<infer T> ? T : never,
): DeezerPlaylistSummary | null {
  const id = item.id;
  const name = item.title?.trim();
  if (!id || !name) return null;
  return {
    provider: "deezer",
    id: String(id),
    name,
    description: item.description?.trim() ?? "",
    imageUrl: item.picture_medium ?? null,
    externalUrl: item.link?.trim() || `https://www.deezer.com/playlist/${id}`,
    owner: item.creator?.name?.trim() ?? null,
    trackCount: typeof item.nb_tracks === "number" ? item.nb_tracks : null,
  };
}

export async function searchDeezerPlaylists(
  query: string,
  limit = 20,
): Promise<DeezerPlaylistSummary[]> {
  const enabled = process.env.DEEZER_ENABLED === "true";
  if (!enabled) return [];

  const safeLimit = Math.max(1, Math.min(limit, 50));
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const url = new URL("https://api.deezer.com/search/playlist");
  url.searchParams.set("q", trimmed);
  url.searchParams.set("limit", String(safeLimit));

  const payload = (await fetchJsonWithTimeout(url, {}, {
    context: {
      provider: "deezer",
      route: "search_playlists",
      query: trimmed,
    },
  })) as DeezerPlaylistPayload | null;

  const seen = new Set<string>();
  const playlists: DeezerPlaylistSummary[] = [];
  for (const item of payload?.data ?? []) {
    const playlist = toDeezerPlaylistSummary(item);
    if (!playlist) continue;
    const key = playlist.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    playlists.push(playlist);
    if (playlists.length >= safeLimit) break;
  }

  return playlists;
}
