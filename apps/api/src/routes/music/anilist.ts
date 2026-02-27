import { fetchJsonWithTimeout } from "./http";
import { readEnvVar } from "../../lib/env";
import { logEvent } from "../../lib/logger";
import { unifiedMusicSearch } from "../../services/MusicAggregator";
import type { MusicTrack } from "../../services/music-types";

type AniListMediaTitle = {
  romaji?: string | null;
  english?: string | null;
  native?: string | null;
};

type AniListPayload = {
  data?: {
    MediaListCollection?: {
      lists?: Array<{
        entries?: Array<{
          media?: {
            id?: number | null;
            title?: AniListMediaTitle | null;
            synonyms?: string[] | null;
          } | null;
        }>;
      }>;
    };
  };
};

export type AniListAnimeEntry = {
  id: string;
  canonicalTitle: string;
  synonyms: string[];
};

const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";

function pickTitle(title: AniListMediaTitle | null | undefined) {
  const candidates = [title?.romaji, title?.english, title?.native];
  for (const value of candidates) {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

const MEDIA_LIST_QUERY = `
query ($userName: String) {
  MediaListCollection(
    userName: $userName
    type: ANIME
    status_in: [CURRENT, COMPLETED]
    sort: [UPDATED_TIME_DESC]
  ) {
    lists {
      entries {
        media {
          id
          title {
            romaji
            english
            native
          }
          synonyms
        }
      }
    }
  }
}
`;

function normalizeSynonyms(values: Array<string | null | undefined>, canonicalTitle: string) {
  const output: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    const normalized = value?.trim() ?? "";
    if (normalized.length <= 0) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    output.push(normalized);
  };

  push(canonicalTitle);
  for (const value of values) {
    push(value);
  }
  return output;
}

export async function fetchAniListUserAnimeEntries(userName: string, limit = 80): Promise<AniListAnimeEntry[]> {
  const trimmed = userName.trim();
  if (trimmed.length === 0) return [];

  const accessToken = readEnvVar("ANILIST_ACCESS_TOKEN");
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (accessToken && accessToken.trim().length > 0) {
    headers.authorization = `Bearer ${accessToken.trim()}`;
  }

  const payload = (await fetchJsonWithTimeout(
    ANILIST_GRAPHQL_URL,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: MEDIA_LIST_QUERY,
        variables: {
          userName: trimmed,
        },
      }),
    },
    {
      timeoutMs: 8_000,
      retries: 1,
      retryDelayMs: 350,
      context: {
        provider: "anilist",
        route: "media_list_collection",
        userName: trimmed,
      },
    },
  )) as AniListPayload | null;

  const seen = new Set<string>();
  const entries: AniListAnimeEntry[] = [];
  const lists = payload?.data?.MediaListCollection?.lists ?? [];
  for (const list of lists) {
    const mediaEntries = list.entries ?? [];
    for (const entry of mediaEntries) {
      const title = pickTitle(entry.media?.title);
      if (!title) continue;

      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        id: String(entry.media?.id ?? key),
        canonicalTitle: title,
        synonyms: normalizeSynonyms(entry.media?.synonyms ?? [], title),
      });

      if (entries.length >= limit) return entries;
    }
  }

  return entries;
}

export async function fetchAniListUserAnimeTitles(userName: string, limit = 80): Promise<string[]> {
  const entries = await fetchAniListUserAnimeEntries(userName, limit);
  return entries.map((entry) => entry.canonicalTitle);
}

function normalizeUsernames(input: string[]) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of input) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(trimmed);
  }
  return output;
}

export async function fetchAniListUsersOpeningTracks(
  usernames: string[],
  limit = 20,
): Promise<MusicTrack[]> {
  const safeLimit = Math.max(1, Math.min(limit, 30));
  const cleanUsernames = normalizeUsernames(usernames).slice(0, 8);
  if (cleanUsernames.length === 0) return [];

  const entriesByUser = await Promise.all(
    cleanUsernames.map(async (username) => ({
      username,
      entries: await fetchAniListUserAnimeEntries(username, 80),
    })),
  );

  const mergedEntries = entriesByUser.flatMap((entry) => entry.entries);
  const dedupedEntries: AniListAnimeEntry[] = [];
  const seenTitles = new Set<string>();
  for (const entry of mergedEntries) {
    const key = entry.canonicalTitle.toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    dedupedEntries.push(entry);
  }

  const resolvedTracks: MusicTrack[] = [];
  const seenTrackSignatures = new Set<string>();

  for (const entry of dedupedEntries) {
    const title = entry.canonicalTitle;
    const query = `${title} opening`;
    const search = await unifiedMusicSearch(query, 4, {
      providerOrder: ["youtube", "spotify", "deezer", "apple-music", "tidal"],
      targetFallbackCount: 4,
    });

    const candidate =
      search.fallback.find((track) => track.previewUrl !== null) ?? search.fallback[0] ?? null;
    if (!candidate) continue;

    const signature = `${candidate.title.toLowerCase()}::${candidate.artist.toLowerCase()}`;
    if (seenTrackSignatures.has(signature)) continue;
    seenTrackSignatures.add(signature);
    resolvedTracks.push({
      ...candidate,
      answer: {
        canonical: entry.canonicalTitle,
        aliases: entry.synonyms,
        mode: "anime",
      },
    });

    if (resolvedTracks.length >= safeLimit) break;
  }

  logEvent("info", "anilist_opening_tracks_resolved", {
    usernames: cleanUsernames,
    sourceTitleCount: dedupedEntries.length,
    resolvedTrackCount: resolvedTracks.length,
    requestedLimit: safeLimit,
  });

  return resolvedTracks;
}
