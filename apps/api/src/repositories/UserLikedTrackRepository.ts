import { pool } from "../db/client";

export type LibraryProvider = "spotify" | "deezer";

export type SyncedLibraryTrack = {
  userId: string;
  provider: LibraryProvider;
  sourceId: string;
  title: string;
  artist: string;
  youtubeVideoId: string | null;
  durationMs: number | null;
  addedAtMs: number;
};

type ListOrder = "recent" | "random";

function memoryKey(userId: string, provider: LibraryProvider) {
  return `${userId}:${provider}`;
}

type MemoryUserLikedTrack = {
  sourceId: string;
  addedAtMs: number;
  title: string;
  artist: string;
  durationMs: number | null;
};

function randomShuffle<T>(values: T[]) {
  const copied = [...values];
  for (let index = copied.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = copied[index];
    copied[index] = copied[swapIndex] as T;
    copied[swapIndex] = current as T;
  }
  return copied;
}

export class UserLikedTrackRepository {
  private readonly memoryUserTracks = new Map<string, MemoryUserLikedTrack[]>();

  private get dbEnabled() {
    const value = process.env.DATABASE_URL;
    return typeof value === "string" && value.trim().length > 0;
  }

  async replaceForUserProvider(input: {
    userId: string;
    provider: LibraryProvider;
    tracks: Array<{
      sourceId: string;
      addedAtMs: number;
      title: string;
      artist: string;
      durationMs: number | null;
    }>;
  }) {
    const userId = input.userId.trim();
    const provider = input.provider;
    if (!userId) return { savedCount: 0 };

    const normalized = input.tracks
      .map((track) => {
        const sourceId = track.sourceId.trim();
        if (!sourceId) return null;
        const addedAtMs =
          typeof track.addedAtMs === "number" && Number.isFinite(track.addedAtMs)
            ? Math.max(0, Math.floor(track.addedAtMs))
            : Date.now();
        return {
          sourceId,
          addedAtMs,
          title: track.title.trim(),
          artist: track.artist.trim(),
          durationMs:
            typeof track.durationMs === "number" && Number.isFinite(track.durationMs)
              ? Math.max(0, Math.round(track.durationMs))
              : null,
        };
      })
      .filter((track) => track !== null && track.title.length > 0 && track.artist.length > 0);

    if (!this.dbEnabled) {
      this.memoryUserTracks.set(memoryKey(userId, provider), normalized);
      return { savedCount: normalized.length };
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `
          delete from user_liked_tracks
          where user_id = $1 and provider = $2
        `,
        [userId, provider],
      );

      const batchSize = 500;
      for (let start = 0; start < normalized.length; start += batchSize) {
        const batch = normalized.slice(start, start + batchSize);
        const sourceIds = batch.map((track) => track.sourceId);
        const addedAts = batch.map((track) => new Date(track.addedAtMs));
        await client.query(
          `
            insert into user_liked_tracks (user_id, provider, source_id, added_at)
            select $1::text, $2::text, source_id, added_at
            from unnest($3::text[], $4::timestamptz[]) as source_rows(source_id, added_at)
          `,
          [userId, provider, sourceIds, addedAts],
        );
      }

      await client.query("commit");
      return { savedCount: normalized.length };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listForUsers(input: {
    userIds: string[];
    providers: LibraryProvider[];
    limit: number;
    orderBy?: ListOrder;
    randomSeed?: string;
  }): Promise<SyncedLibraryTrack[]> {
    const userIds = input.userIds.map((value) => value.trim()).filter((value) => value.length > 0);
    const providers = input.providers;
    const limit = Math.max(1, Math.min(input.limit, 10_000));
    const orderBy: ListOrder = input.orderBy === "random" ? "random" : "recent";
    const randomSeed = (input.randomSeed?.trim() || `${Date.now()}:${Math.random()}`).slice(0, 120);
    if (userIds.length <= 0 || providers.length <= 0) return [];

    if (!this.dbEnabled) {
      const rows: SyncedLibraryTrack[] = [];
      for (const userId of userIds) {
        for (const provider of providers) {
          const entries = this.memoryUserTracks.get(memoryKey(userId, provider)) ?? [];
          for (const entry of entries) {
            rows.push({
              userId,
              provider,
              sourceId: entry.sourceId,
              title: entry.title,
              artist: entry.artist,
              youtubeVideoId: null,
              durationMs: entry.durationMs,
              addedAtMs: entry.addedAtMs,
            });
          }
        }
      }
      if (orderBy === "random") {
        return randomShuffle(rows).slice(0, limit);
      }
      rows.sort((left, right) => right.addedAtMs - left.addedAtMs);
      return rows.slice(0, limit);
    }

    const orderClause =
      orderBy === "random"
        ? "md5(concat($4::text, ':', ult.provider, ':', ult.source_id)) asc"
        : "ult.added_at desc";

    const queryValues =
      orderBy === "random"
        ? [userIds, providers, limit, randomSeed]
        : [userIds, providers, limit];

    const result = await pool.query<{
      user_id: string;
      provider: string;
      source_id: string;
      added_at: Date;
      title: string;
      artist: string;
      youtube_video_id: string | null;
      duration_ms: number | null;
    }>(
      `
        select ult.user_id, ult.provider, ult.source_id, ult.added_at, rt.title, rt.artist, rt.youtube_video_id, rt.duration_ms
        from user_liked_tracks ult
        inner join resolved_tracks rt
          on rt.provider = ult.provider
         and rt.source_id = ult.source_id
        where ult.user_id = any($1::text[])
          and ult.provider = any($2::text[])
        order by ${orderClause}
        limit $3
      `,
      queryValues,
    );

    const tracks: SyncedLibraryTrack[] = [];
    for (const row of result.rows) {
      const provider = row.provider === "spotify" || row.provider === "deezer" ? row.provider : null;
      if (!provider) continue;
      tracks.push({
        userId: row.user_id,
        provider,
        sourceId: row.source_id,
        title: row.title,
        artist: row.artist,
        youtubeVideoId: row.youtube_video_id,
        durationMs: row.duration_ms,
        addedAtMs: row.added_at.getTime(),
      });
    }
    return tracks;
  }

  async countForUserByProvider(userIdInput: string): Promise<Record<LibraryProvider, number>> {
    const userId = userIdInput.trim();
    if (!userId) {
      return { spotify: 0, deezer: 0 };
    }

    if (!this.dbEnabled) {
      return {
        spotify: (this.memoryUserTracks.get(memoryKey(userId, "spotify")) ?? []).length,
        deezer: (this.memoryUserTracks.get(memoryKey(userId, "deezer")) ?? []).length,
      };
    }

    const result = await pool.query<{
      provider: string;
      count: string;
    }>(
      `
        select provider, count(*)::text as count
        from user_liked_tracks
        where user_id = $1
        group by provider
      `,
      [userId],
    );

    const counts: Record<LibraryProvider, number> = { spotify: 0, deezer: 0 };
    for (const row of result.rows) {
      if (row.provider !== "spotify" && row.provider !== "deezer") continue;
      const parsed = Number.parseInt(row.count, 10);
      counts[row.provider] = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    }
    return counts;
  }

  clearMemory() {
    this.memoryUserTracks.clear();
  }
}

export const userLikedTrackRepository = new UserLikedTrackRepository();
