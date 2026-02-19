import { randomUUID } from "node:crypto";
import { pool } from "../db/client";

export type MatchRankingEntry = {
  rank: number;
  playerId: string;
  userId: string | null;
  displayName: string;
  score: number;
  maxStreak: number;
  averageResponseMs: number | null;
};

type MatchRecord = {
  id: string;
  roomCode: string;
  categoryQuery: string;
  finishedAtMs: number;
  ranking: MatchRankingEntry[];
};

type UserStats = {
  matchesPlayed: number;
  top1Count: number;
  bestStreak: number;
};

type MatchInsertInput = {
  roomCode: string;
  categoryQuery: string;
  ranking: MatchRankingEntry[];
  finishedAtMs?: number;
};

export function buildMatchInsertPayload(input: {
  roomCode: string;
  categoryQuery: string;
  ranking: unknown[];
}) {
  return {
    roomCode: input.roomCode,
    config: {
      categoryQuery: input.categoryQuery,
      rankingSize: input.ranking.length,
    },
  };
}

function emptyStats(): UserStats {
  return {
    matchesPlayed: 0,
    top1Count: 0,
    bestStreak: 0,
  };
}

function readCategoryQuery(config: unknown): string {
  if (typeof config === "object" && config !== null) {
    const record = config as Record<string, unknown>;
    const categoryQuery = record.categoryQuery;
    if (typeof categoryQuery === "string" && categoryQuery.length > 0) {
      return categoryQuery;
    }
  }
  return "popular hits";
}

export class MatchRepository {
  private readonly memoryMatches: MatchRecord[] = [];
  private readonly roomCodeIndex = new Set<string>();

  private get dbEnabled() {
    const value = process.env.DATABASE_URL;
    return typeof value === "string" && value.trim().length > 0;
  }

  async recordMatch(input: MatchInsertInput) {
    const finishedAtMs = input.finishedAtMs ?? Date.now();

    if (!this.dbEnabled) {
      if (this.roomCodeIndex.has(input.roomCode)) {
        return { ok: false as const, error: "MATCH_ALREADY_RECORDED" as const };
      }

      const record: MatchRecord = {
        id: randomUUID(),
        roomCode: input.roomCode,
        categoryQuery: input.categoryQuery,
        finishedAtMs,
        ranking: input.ranking,
      };
      this.memoryMatches.push(record);
      this.roomCodeIndex.add(input.roomCode);

      return { ok: true as const, matchId: record.id };
    }

    const client = await pool.connect();
    let inTransaction = false;

    try {
      await client.query("begin");
      inTransaction = true;

      const existing = await client.query<{ id: number }>(
        "select id from matches where room_code = $1 limit 1",
        [input.roomCode],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        await client.query("rollback");
        inTransaction = false;
        return { ok: false as const, error: "MATCH_ALREADY_RECORDED" as const };
      }

      const payload = buildMatchInsertPayload({
        roomCode: input.roomCode,
        categoryQuery: input.categoryQuery,
        ranking: input.ranking,
      });

      const inserted = await client.query<{ id: number }>(
        `
          insert into matches (room_code, config, finished_at)
          values ($1, $2::jsonb, $3)
          returning id
        `,
        [payload.roomCode, JSON.stringify(payload.config), new Date(finishedAtMs)],
      );
      const matchId = inserted.rows[0]?.id;
      if (!matchId) throw new Error("MATCH_INSERT_FAILED");

      for (const entry of input.ranking) {
        await client.query(
          `
            insert into match_participants
              (match_id, player_id, user_id, display_name, final_rank, score, max_streak)
            values
              ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            matchId,
            entry.playerId,
            entry.userId,
            entry.displayName,
            entry.rank,
            entry.score,
            entry.maxStreak,
          ],
        );
      }

      await client.query("commit");
      inTransaction = false;
      return { ok: true as const, matchId: String(matchId) };
    } catch (error) {
      if (inTransaction) {
        await client.query("rollback");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getUserHistory(userId: string) {
    if (!this.dbEnabled) {
      const matches = this.memoryMatches
        .filter((match) => match.ranking.some((entry) => entry.userId === userId))
        .sort((a, b) => b.finishedAtMs - a.finishedAtMs);

      const stats = matches.reduce<UserStats>((acc, match) => {
        const entry = match.ranking.find((row) => row.userId === userId);
        if (!entry) return acc;
        acc.matchesPlayed += 1;
        if (entry.rank === 1) acc.top1Count += 1;
        acc.bestStreak = Math.max(acc.bestStreak, entry.maxStreak);
        return acc;
      }, emptyStats());

      return { stats, matches };
    }

    const [statsResult, matchesResult] = await Promise.all([
      pool.query<{
        matches_played: number | string;
        top1_count: number | string;
        best_streak: number | string | null;
      }>(
        `
          select
            count(*)::int as matches_played,
            count(*) filter (where final_rank = 1)::int as top1_count,
            coalesce(max(max_streak), 0)::int as best_streak
          from match_participants
          where user_id = $1
        `,
        [userId],
      ),
      pool.query<{
        id: number;
        room_code: string;
        config: unknown;
        finished_at: Date | null;
        created_at: Date;
      }>(
        `
          select m.id, m.room_code, m.config, m.finished_at, m.created_at
          from matches m
          join match_participants p on p.match_id = m.id
          where p.user_id = $1
          order by coalesce(m.finished_at, m.created_at) desc
        `,
        [userId],
      ),
    ]);

    const matchRows = matchesResult.rows;
    const matchIds = matchRows.map((row) => row.id);

    const rankingByMatchId = new Map<number, MatchRankingEntry[]>();
    if (matchIds.length > 0) {
      const rankingResult = await pool.query<{
        match_id: number;
        player_id: string;
        user_id: string | null;
        display_name: string;
        final_rank: number | null;
        score: number;
        max_streak: number;
      }>(
        `
          select
            match_id,
            player_id,
            user_id,
            display_name,
            final_rank,
            score,
            max_streak
          from match_participants
          where match_id = any($1::bigint[])
          order by match_id asc, final_rank asc nulls last, score desc
        `,
        [matchIds],
      );

      for (const row of rankingResult.rows) {
        const ranking = rankingByMatchId.get(row.match_id) ?? [];
        ranking.push({
          rank: row.final_rank ?? ranking.length + 1,
          playerId: row.player_id,
          userId: row.user_id,
          displayName: row.display_name,
          score: row.score,
          maxStreak: row.max_streak,
          averageResponseMs: null,
        });
        rankingByMatchId.set(row.match_id, ranking);
      }
    }

    const statsRow = statsResult.rows[0];
    const stats: UserStats = statsRow
      ? {
          matchesPlayed: Number(statsRow.matches_played) || 0,
          top1Count: Number(statsRow.top1_count) || 0,
          bestStreak: Number(statsRow.best_streak) || 0,
        }
      : emptyStats();

    const matches: MatchRecord[] = matchRows.map((row) => ({
      id: String(row.id),
      roomCode: row.room_code,
      categoryQuery: readCategoryQuery(row.config),
      finishedAtMs: (row.finished_at ?? row.created_at).getTime(),
      ranking: rankingByMatchId.get(row.id) ?? [],
    }));

    return { stats, matches };
  }
}

export const matchRepository = new MatchRepository();
