import { fetchJsonWithTimeout } from "./http";
import type { MusicTrack } from "../../services/music-types";

type YouTubePayload = {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      channelTitle?: string;
    };
  }>;
};

export async function searchYouTube(query: string, limit = 10): Promise<MusicTrack[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];

  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", String(limit));
  url.searchParams.set("q", query);
  url.searchParams.set("key", apiKey);

  const payload = (await fetchJsonWithTimeout(url)) as YouTubePayload | null;
  const items = payload?.items ?? [];

  return items
    .map((item) => {
      const id = item.id?.videoId;
      const title = item.snippet?.title?.trim();
      const artist = item.snippet?.channelTitle?.trim();
      if (!id || !title || !artist) return null;
      return {
        provider: "youtube" as const,
        id,
        title,
        artist,
        previewUrl: null,
      };
    })
    .filter((value): value is MusicTrack => value !== null);
}
