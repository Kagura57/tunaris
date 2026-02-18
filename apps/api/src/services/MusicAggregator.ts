import { searchAppleMusic } from "../routes/music/apple";
import { searchDeezer } from "../routes/music/deezer";
import { searchSpotify } from "../routes/music/spotify";
import { searchTidal } from "../routes/music/tidal";
import { searchYouTube } from "../routes/music/youtube";
import { searchYTMusic } from "../routes/music/ytmusic";
import type { MusicProvider, MusicTrack, ProviderSearchFn } from "./music-types";

export const PROVIDER_ORDER: MusicProvider[] = [
  "spotify",
  "deezer",
  "apple-music",
  "tidal",
  "ytmusic",
  "youtube",
];

type UnifiedSearchOptions = {
  searchers?: Partial<Record<MusicProvider, ProviderSearchFn>>;
  providerOrder?: MusicProvider[];
  targetFallbackCount?: number;
};

type UnifiedSearchResult = {
  query: string;
  limit: number;
  fallback: MusicTrack[];
  results: Record<MusicProvider, MusicTrack[]>;
  providerErrors: Partial<Record<MusicProvider, string>>;
};

const DEFAULT_SEARCHERS: Record<MusicProvider, ProviderSearchFn> = {
  spotify: searchSpotify,
  deezer: searchDeezer,
  "apple-music": searchAppleMusic,
  tidal: searchTidal,
  ytmusic: searchYTMusic,
  youtube: searchYouTube,
};

function defaultResultsMap(): Record<MusicProvider, MusicTrack[]> {
  return {
    spotify: [],
    deezer: [],
    "apple-music": [],
    tidal: [],
    ytmusic: [],
    youtube: [],
  };
}

function trackSignature(track: MusicTrack) {
  return `${track.title.toLowerCase()}::${track.artist.toLowerCase()}`;
}

function buildFallback(
  perProvider: Record<MusicProvider, MusicTrack[]>,
  providerOrder: MusicProvider[],
  targetFallbackCount: number,
) {
  const seen = new Set<string>();
  const fallback: MusicTrack[] = [];

  for (const provider of providerOrder) {
    const tracks = perProvider[provider];
    for (const track of tracks) {
      const signature = trackSignature(track);
      if (seen.has(signature)) continue;
      seen.add(signature);
      fallback.push(track);
      if (fallback.length >= targetFallbackCount) {
        return fallback;
      }
    }
  }

  return fallback;
}

function readErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return "UNKNOWN_ERROR";
}

export async function unifiedMusicSearch(
  query: string,
  limit = 10,
  options: UnifiedSearchOptions = {},
): Promise<UnifiedSearchResult> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const targetFallbackCount = Math.max(1, Math.min(options.targetFallbackCount ?? safeLimit, 100));
  const providerOrder = options.providerOrder ?? PROVIDER_ORDER;
  const searchers = { ...DEFAULT_SEARCHERS, ...(options.searchers ?? {}) };

  const providerResults = defaultResultsMap();
  const providerErrors: Partial<Record<MusicProvider, string>> = {};

  await Promise.all(
    providerOrder.map(async (provider) => {
      const searcher = searchers[provider];
      try {
        providerResults[provider] = await searcher(query, safeLimit);
      } catch (error) {
        providerResults[provider] = [];
        providerErrors[provider] = readErrorMessage(error);
      }
    }),
  );

  const fallback = buildFallback(providerResults, providerOrder, targetFallbackCount);

  return {
    query,
    limit: safeLimit,
    fallback,
    results: providerResults,
    providerErrors,
  };
}
