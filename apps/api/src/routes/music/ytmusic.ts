import { fetchJsonWithTimeout } from "./http";
import type { MusicTrack } from "../../services/music-types";

type YTMusicPayload = {
  data?: Array<{
    id?: string;
    title?: string;
    artist?: string;
    previewUrl?: string | null;
  }>;
};

export async function searchYTMusic(query: string, limit = 10): Promise<MusicTrack[]> {
  const searchUrl = process.env.YTMUSIC_SEARCH_URL;
  if (!searchUrl) return [];

  const url = new URL(searchUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  const payload = (await fetchJsonWithTimeout(url)) as YTMusicPayload | null;
  const items = payload?.data ?? [];

  return items
    .map((item) => {
      const title = item.title?.trim();
      const artist = item.artist?.trim();
      if (!item.id || !title || !artist) return null;
      return {
        provider: "ytmusic" as const,
        id: item.id,
        title,
        artist,
        previewUrl: item.previewUrl ?? null,
      };
    })
    .filter((value): value is MusicTrack => value !== null);
}
