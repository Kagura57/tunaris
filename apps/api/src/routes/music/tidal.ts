import { fetchJsonWithTimeout } from "./http";
import type { MusicTrack } from "../../services/music-types";

type TidalPayload = {
  data?: Array<{
    id?: string | number;
    title?: string;
    artist?: { name?: string } | string;
    previewUrl?: string | null;
    preview_url?: string | null;
  }>;
};

function extractArtist(raw: { name?: string } | string | undefined) {
  if (typeof raw === "string") {
    const value = raw.trim();
    return value.length > 0 ? value : null;
  }
  if (raw && typeof raw.name === "string") {
    const value = raw.name.trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

export async function searchTidal(query: string, limit = 10): Promise<MusicTrack[]> {
  const token = process.env.TIDAL_API_TOKEN;
  const searchUrl = process.env.TIDAL_SEARCH_URL;
  if (!token || !searchUrl) return [];

  const url = new URL(searchUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  const payload = (await fetchJsonWithTimeout(url, {
    headers: { authorization: `Bearer ${token}` },
  }, {
    context: {
      provider: "tidal",
      query,
    },
  })) as TidalPayload | null;
  const items = payload?.data ?? [];

  return items
    .map((item) => {
      const id = item.id;
      const title = item.title?.trim();
      const artist = extractArtist(item.artist);
      if (!id || !title || !artist) return null;
      return {
        provider: "tidal" as const,
        id: String(id),
        title,
        artist,
        previewUrl: item.previewUrl ?? item.preview_url ?? null,
        sourceUrl: `https://listen.tidal.com/track/${id}`,
      };
    })
    .filter((value): value is MusicTrack => value !== null);
}
