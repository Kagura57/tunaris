import { fetchJsonWithTimeout } from "./http";
import type { MusicTrack } from "../../services/music-types";

type ApplePayload = {
  results?: {
    songs?: {
      data?: Array<{
        id?: string;
        attributes?: {
          name?: string;
          artistName?: string;
          previews?: Array<{ url?: string }>;
        };
      }>;
    };
  };
};

export async function searchAppleMusic(query: string, limit = 10): Promise<MusicTrack[]> {
  const developerToken = process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
  const storefront = process.env.APPLE_MUSIC_STOREFRONT ?? "us";
  if (!developerToken) return [];

  const url = new URL(`https://api.music.apple.com/v1/catalog/${storefront}/search`);
  url.searchParams.set("term", query);
  url.searchParams.set("types", "songs");
  url.searchParams.set("limit", String(limit));

  const payload = (await fetchJsonWithTimeout(url, {
    headers: { authorization: `Bearer ${developerToken}` },
  })) as ApplePayload | null;

  const items = payload?.results?.songs?.data ?? [];
  return items
    .map((item) => {
      const title = item.attributes?.name?.trim();
      const artist = item.attributes?.artistName?.trim();
      if (!item.id || !title || !artist) return null;
      return {
        provider: "apple-music" as const,
        id: item.id,
        title,
        artist,
        previewUrl: item.attributes?.previews?.[0]?.url ?? null,
      };
    })
    .filter((value): value is MusicTrack => value !== null);
}
