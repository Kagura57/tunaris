export type MusicProvider = "spotify" | "deezer" | "apple-music" | "tidal" | "youtube" | "animethemes";

export type MusicTrack = {
  provider: MusicProvider;
  id: string;
  title: string;
  artist: string;
  durationSec?: number | null;
  previewUrl: string | null;
  sourceUrl: string | null;
  answer?: {
    canonical: string;
    aliases: string[];
    mode: "anime";
  } | null;
};

export type ProviderSearchFn = (query: string, limit: number) => Promise<MusicTrack[]>;
