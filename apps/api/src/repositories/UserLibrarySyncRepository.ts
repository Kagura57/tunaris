import { pool } from "../db/client";

export type LibrarySyncStatus = "idle" | "syncing" | "completed" | "error";

export type UserLibrarySyncState = {
  userId: string;
  status: LibrarySyncStatus;
  progress: number;
  totalTracks: number;
  lastError: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  updatedAtMs: number;
};

function clampProgress(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeStatus(value: string | null | undefined): LibrarySyncStatus {
  if (value === "syncing" || value === "completed" || value === "error") return value;
  return "idle";
}

export class UserLibrarySyncRepository {
  private readonly memory = new Map<string, UserLibrarySyncState>();

  private get dbEnabled() {
    const value = process.env.DATABASE_URL;
    return typeof value === "string" && value.trim().length > 0;
  }

  async get(userId: string): Promise<UserLibrarySyncState> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return {
        userId: "",
        status: "idle",
        progress: 0,
        totalTracks: 0,
        lastError: null,
        startedAtMs: null,
        completedAtMs: null,
        updatedAtMs: Date.now(),
      };
    }

    if (!this.dbEnabled) {
      return (
        this.memory.get(normalizedUserId) ?? {
          userId: normalizedUserId,
          status: "idle",
          progress: 0,
          totalTracks: 0,
          lastError: null,
          startedAtMs: null,
          completedAtMs: null,
          updatedAtMs: Date.now(),
        }
      );
    }

    const result = await pool.query<{
      user_id: string;
      status: string;
      progress: number;
      total_tracks: number;
      last_error: string | null;
      started_at: Date | null;
      completed_at: Date | null;
      updated_at: Date;
    }>(
      `
        select user_id, status, progress, total_tracks, last_error, started_at, completed_at, updated_at
        from user_library_syncs
        where user_id = $1
        limit 1
      `,
      [normalizedUserId],
    );
    const row = result.rows[0];
    if (!row) {
      return {
        userId: normalizedUserId,
        status: "idle",
        progress: 0,
        totalTracks: 0,
        lastError: null,
        startedAtMs: null,
        completedAtMs: null,
        updatedAtMs: Date.now(),
      };
    }

    return {
      userId: row.user_id,
      status: normalizeStatus(row.status),
      progress: clampProgress(row.progress),
      totalTracks: Number.isFinite(row.total_tracks) ? Math.max(0, Math.round(row.total_tracks)) : 0,
      lastError: row.last_error,
      startedAtMs: row.started_at ? row.started_at.getTime() : null,
      completedAtMs: row.completed_at ? row.completed_at.getTime() : null,
      updatedAtMs: row.updated_at.getTime(),
    };
  }

  async upsert(input: {
    userId: string;
    status: LibrarySyncStatus;
    progress?: number;
    totalTracks?: number;
    lastError?: string | null;
    startedAtMs?: number | null;
    completedAtMs?: number | null;
  }): Promise<UserLibrarySyncState> {
    const userId = input.userId.trim();
    if (!userId) {
      throw new Error("INVALID_USER_ID");
    }
    const status = input.status;
    const progress = clampProgress(input.progress ?? 0);
    const totalTracks =
      typeof input.totalTracks === "number" && Number.isFinite(input.totalTracks)
        ? Math.max(0, Math.round(input.totalTracks))
        : 0;
    const lastError = typeof input.lastError === "string" ? input.lastError : null;
    const startedAt =
      typeof input.startedAtMs === "number" && Number.isFinite(input.startedAtMs)
        ? new Date(Math.max(0, Math.round(input.startedAtMs)))
        : null;
    const completedAt =
      typeof input.completedAtMs === "number" && Number.isFinite(input.completedAtMs)
        ? new Date(Math.max(0, Math.round(input.completedAtMs)))
        : null;

    if (!this.dbEnabled) {
      const nowMs = Date.now();
      const next = {
        userId,
        status,
        progress,
        totalTracks,
        lastError,
        startedAtMs: startedAt ? startedAt.getTime() : null,
        completedAtMs: completedAt ? completedAt.getTime() : null,
        updatedAtMs: nowMs,
      } satisfies UserLibrarySyncState;
      this.memory.set(userId, next);
      return next;
    }

    const result = await pool.query<{
      user_id: string;
      status: string;
      progress: number;
      total_tracks: number;
      last_error: string | null;
      started_at: Date | null;
      completed_at: Date | null;
      updated_at: Date;
    }>(
      `
        insert into user_library_syncs
          (user_id, status, progress, total_tracks, last_error, started_at, completed_at, updated_at)
        values
          ($1, $2, $3, $4, $5, $6, $7, now())
        on conflict (user_id)
        do update set
          status = excluded.status,
          progress = excluded.progress,
          total_tracks = excluded.total_tracks,
          last_error = excluded.last_error,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          updated_at = now()
        returning user_id, status, progress, total_tracks, last_error, started_at, completed_at, updated_at
      `,
      [userId, status, progress, totalTracks, lastError, startedAt, completedAt],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("SYNC_STATE_WRITE_FAILED");
    }

    return {
      userId: row.user_id,
      status: normalizeStatus(row.status),
      progress: clampProgress(row.progress),
      totalTracks: Number.isFinite(row.total_tracks) ? Math.max(0, Math.round(row.total_tracks)) : 0,
      lastError: row.last_error,
      startedAtMs: row.started_at ? row.started_at.getTime() : null,
      completedAtMs: row.completed_at ? row.completed_at.getTime() : null,
      updatedAtMs: row.updated_at.getTime(),
    };
  }
}

export const userLibrarySyncRepository = new UserLibrarySyncRepository();
