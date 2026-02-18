import { fetchJsonWithTimeout } from "./http";
import type { MusicTrack } from "../../services/music-types";

type SpotifyArtist = { name?: string };
type SpotifyItem = {
  id?: string;
  name?: string;
  artists?: SpotifyArtist[];
  preview_url?: string | null;
};
type SpotifyPayload = { tracks?: { items?: SpotifyItem[] } };

export async function searchSpotify(query: string, limit = 10): Promise<MusicTrack[]> {
  const token = process.env.SPOTIFY_ACCESS_TOKEN;
  if (!token) return [];

  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("type", "track");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  const payload = (await fetchJsonWithTimeout(url, {
    headers: { authorization: `Bearer ${token}` },
  })) as SpotifyPayload | null;

  const items = payload?.tracks?.items ?? [];
  return items
    .map((item) => {
      const title = item.name?.trim();
      const artist = item.artists?.[0]?.name?.trim();
      if (!item.id || !title || !artist) return null;
      return {
        provider: "spotify" as const,
        id: item.id,
        title,
        artist,
        previewUrl: item.preview_url ?? null,
      };
    })
    .filter((value): value is MusicTrack => value !== null);
}
