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

const YOUTUBE_FAILURE_BACKOFF_MS = 60_000;
let youtubeSearchBackoffUntilMs = 0;

function readYouTubeApiKey() {
  const candidates = [process.env.YOUTUBE_API_KEY, process.env.GOOGLE_API_KEY, process.env.YT_API_KEY];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized.length > 0) return normalized;
  }
  return null;
}

export async function searchYouTube(query: string, limit = 10): Promise<MusicTrack[]> {
  const apiKey = readYouTubeApiKey();
  if (!apiKey) return [];

  const safeLimit = Math.max(1, Math.min(limit, 50));
  if (youtubeSearchBackoffUntilMs > Date.now()) return [];

  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", String(safeLimit));
  url.searchParams.set("q", query);
  url.searchParams.set("videoEmbeddable", "true");
  url.searchParams.set("key", apiKey);

  const payload = (await fetchJsonWithTimeout(url, {}, {
    context: {
      provider: "youtube",
      query,
    },
  })) as YouTubePayload | null;

  if (!payload) {
    youtubeSearchBackoffUntilMs = Date.now() + YOUTUBE_FAILURE_BACKOFF_MS;
    return [];
  }

  youtubeSearchBackoffUntilMs = 0;
  const items = payload.items ?? [];

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
        sourceUrl: `https://www.youtube.com/watch?v=${id}`,
      };
    })
    .filter((value): value is MusicTrack => value !== null);
}
