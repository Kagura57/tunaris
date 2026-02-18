export type MusicProvider = "spotify" | "deezer" | "apple-music" | "tidal" | "ytmusic" | "youtube";

export type MusicTrack = {
  provider: MusicProvider;
  id: string;
  title: string;
  artist: string;
  previewUrl: string | null;
};

export type ProviderSearchFn = (query: string, limit: number) => Promise<MusicTrack[]>;
