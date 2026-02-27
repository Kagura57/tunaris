import { Worker } from "bullmq";
import IORedis from "ioredis";
import { pool } from "../../db/client";
import { readRedisUrl } from "../../lib/env";
import { logEvent } from "../../lib/logger";
import { aniListSyncRunRepository } from "../../repositories/AniListSyncRunRepository";
import { userAnimeLibraryRepository } from "../../repositories/UserAnimeLibraryRepository";
import { getAniListLinkForUser } from "../AniListOAuthService";
import {
  ANILIST_SYNC_JOB_NAME,
  ANILIST_SYNC_QUEUE_NAME,
  type AniListSyncJobPayload,
} from "./anilist-sync-queue";

type AniListCollectionPayload = {
  data?: {
    MediaListCollection?: {
      lists?: Array<{
        entries?: Array<{
          status?: string | null;
          media?: {
            title?: {
              romaji?: string | null;
              english?: string | null;
              native?: string | null;
            } | null;
          } | null;
        }>;
      }>;
    };
  };
};

let workerInstance: Worker<AniListSyncJobPayload> | null = null;
let workerConnection: IORedis | null = null;

function normalizeAnimeAlias(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAniListListStatus(input: string | null | undefined): "WATCHING" | "COMPLETED" | null {
  if (input === "CURRENT") return "WATCHING";
  if (input === "COMPLETED") return "COMPLETED";
  return null;
}

function extractTitles(entry: {
  media?: {
    title?: {
      romaji?: string | null;
      english?: string | null;
      native?: string | null;
    } | null;
  } | null;
}) {
  const title = entry.media?.title;
  const values = [title?.romaji, title?.english, title?.native]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0);
  return Array.from(new Set(values));
}

async function fetchAniListCollection(accessToken: string) {
  const response = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: `
        query {
          MediaListCollection(type: ANIME, status_in: [CURRENT, COMPLETED]) {
            lists {
              entries {
                status
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
      `,
    }),
  });
  if (!response.ok) {
    throw new Error(`ANILIST_COLLECTION_HTTP_${response.status}`);
  }
  return (await response.json()) as AniListCollectionPayload;
}

async function mapTitlesToAnimeIds(normalizedTitles: string[]) {
  if (normalizedTitles.length <= 0) return new Map<string, number>();
  const result = await pool.query<{
    normalized_alias: string;
    anime_id: number;
  }>(
    `
      select normalized_alias, anime_id
      from anime_catalog_alias
      where normalized_alias = any($1::text[])
    `,
    [normalizedTitles],
  );

  const mapped = new Map<string, number>();
  for (const row of result.rows) {
    if (!mapped.has(row.normalized_alias)) {
      mapped.set(row.normalized_alias, row.anime_id);
    }
  }
  return mapped;
}

async function syncAniListLibrary(input: { userId: string; runId: number }) {
  const link = await getAniListLinkForUser(input.userId);
  if (!link?.accessToken) {
    throw new Error("ANILIST_NOT_LINKED");
  }

  const payload = await fetchAniListCollection(link.accessToken);
  const lists = payload.data?.MediaListCollection?.lists ?? [];

  const staged: Array<{ animeId: number; listStatus: "WATCHING" | "COMPLETED" }> = [];
  const seen = new Set<number>();

  const normalizedToStatus = new Map<string, "WATCHING" | "COMPLETED">();
  for (const list of lists) {
    for (const entry of list.entries ?? []) {
      const status = normalizeAniListListStatus(entry.status ?? null);
      if (!status) continue;
      for (const title of extractTitles(entry)) {
        const normalized = normalizeAnimeAlias(title);
        if (!normalized) continue;
        if (!normalizedToStatus.has(normalized)) {
          normalizedToStatus.set(normalized, status);
        }
      }
    }
  }

  const normalizedTitles = [...normalizedToStatus.keys()];
  const titleMap = process.env.DATABASE_URL ? await mapTitlesToAnimeIds(normalizedTitles) : new Map<string, number>();

  for (const [normalizedTitle, status] of normalizedToStatus.entries()) {
    const animeId = titleMap.get(normalizedTitle);
    if (!animeId || seen.has(animeId)) continue;
    seen.add(animeId);
    staged.push({
      animeId,
      listStatus: status,
    });
  }

  await userAnimeLibraryRepository.setStagingForRun({
    runId: input.runId,
    userId: input.userId,
    entries: staged,
  });
  await userAnimeLibraryRepository.replaceFromStaging({
    runId: input.runId,
    userId: input.userId,
  });

  return {
    stagedCount: staged.length,
  };
}

export function startAniListSyncWorker() {
  if (workerInstance) return workerInstance;
  const redisUrl = readRedisUrl();
  if (!redisUrl) {
    logEvent("warn", "anilist_sync_worker_disabled_missing_redis_url");
    return null;
  }

  workerConnection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  workerInstance = new Worker<AniListSyncJobPayload>(
    ANILIST_SYNC_QUEUE_NAME,
    async (job) => {
      const userId = job.data.userId?.trim() ?? "";
      const runId = Math.max(1, Math.floor(job.data.runId ?? 0));
      if (!userId || !runId) {
        throw new Error("INVALID_SYNC_PAYLOAD");
      }

      await aniListSyncRunRepository.update({
        runId,
        status: "running",
        progress: 10,
        startedAtMs: Date.now(),
      });

      try {
        const result = await syncAniListLibrary({ userId, runId });
        await aniListSyncRunRepository.update({
          runId,
          status: "success",
          progress: 100,
          message: `SYNCED_${result.stagedCount}`,
          finishedAtMs: Date.now(),
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
        await aniListSyncRunRepository.update({
          runId,
          status: "error",
          progress: 0,
          message,
          finishedAtMs: Date.now(),
        });
        throw error;
      }
    },
    {
      connection: workerConnection,
      concurrency: 1,
      limiter: {
        max: 1,
        duration: 1_000,
      },
    },
  );

  workerInstance.on("active", (job) => {
    logEvent("info", "anilist_library_sync_job_active", {
      userId: job.data.userId,
      runId: job.data.runId,
      jobId: job.id ?? null,
      attemptsMade: job.attemptsMade,
      name: ANILIST_SYNC_JOB_NAME,
    });
  });

  workerInstance.on("completed", (job) => {
    logEvent("info", "anilist_library_sync_job_completed", {
      userId: job.data.userId,
      runId: job.data.runId,
      jobId: job.id ?? null,
      attemptsMade: job.attemptsMade,
      name: ANILIST_SYNC_JOB_NAME,
    });
  });

  workerInstance.on("failed", (job, error) => {
    logEvent("warn", "anilist_library_sync_job_failed", {
      userId: job?.data?.userId ?? null,
      runId: job?.data?.runId ?? null,
      jobId: job?.id ?? null,
      attemptsMade: job?.attemptsMade ?? 0,
      error: error?.message ?? "UNKNOWN_ERROR",
    });
  });

  return workerInstance;
}
