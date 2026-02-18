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

export async function searchDeezer(query: string, limit = 10): Promise<MusicTrack[]> {
  const enabled = process.env.DEEZER_ENABLED === "true";
  if (!enabled) return [];

  const url = new URL("https://api.deezer.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  const payload = (await fetchJsonWithTimeout(url)) as DeezerPayload | null;
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
      };
    })
    .filter((value): value is MusicTrack => value !== null);
}
