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
            title?: AniListMediaTitle | null;
          } | null;
        }>;
      }>;
    };
  };
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
    status_in: [CURRENT, COMPLETED, REPEATING]
    sort: [UPDATED_TIME_DESC]
  ) {
    lists {
      entries {
        media {
          title {
            romaji
            english
            native
          }
        }
      }
    }
  }
}
`;

export async function fetchAniListUserAnimeTitles(userName: string, limit = 80): Promise<string[]> {
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
  const titles: string[] = [];
  const lists = payload?.data?.MediaListCollection?.lists ?? [];
  for (const list of lists) {
    const entries = list.entries ?? [];
    for (const entry of entries) {
      const title = pickTitle(entry.media?.title);
      if (!title) continue;

      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      titles.push(title);

      if (titles.length >= limit) return titles;
    }
  }

  return titles;
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

  const titlesByUser = await Promise.all(
    cleanUsernames.map(async (username) => ({
      username,
      titles: await fetchAniListUserAnimeTitles(username, 80),
    })),
  );

  const mergedTitles = titlesByUser.flatMap((entry) => entry.titles);
  const dedupedTitles: string[] = [];
  const seen = new Set<string>();
  for (const title of mergedTitles) {
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedTitles.push(title);
  }

  const resolvedTracks: MusicTrack[] = [];
  const seenTrackSignatures = new Set<string>();

  for (const title of dedupedTitles) {
    const query = `${title} opening`;
    const search = await unifiedMusicSearch(query, 4, {
      providerOrder: ["ytmusic", "youtube", "spotify", "deezer", "apple-music", "tidal"],
      targetFallbackCount: 4,
    });

    const candidate =
      search.fallback.find((track) => track.previewUrl !== null) ?? search.fallback[0] ?? null;
    if (!candidate) continue;

    const signature = `${candidate.title.toLowerCase()}::${candidate.artist.toLowerCase()}`;
    if (seenTrackSignatures.has(signature)) continue;
    seenTrackSignatures.add(signature);
    resolvedTracks.push(candidate);

    if (resolvedTracks.length >= safeLimit) break;
  }

  logEvent("info", "anilist_opening_tracks_resolved", {
    usernames: cleanUsernames,
    sourceTitleCount: dedupedTitles.length,
    resolvedTrackCount: resolvedTracks.length,
    requestedLimit: safeLimit,
  });

  return resolvedTracks;
}
