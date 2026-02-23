import { pool } from "../db/client";
import { decryptToken, encryptToken } from "../lib/token-cipher";

export type MusicProvider = "spotify" | "deezer";
export type ProviderLinkStatus = "linked" | "not_linked" | "expired";

type PersistedLink = {
  userId: string;
  provider: MusicProvider;
  providerUserId: string | null;
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
  expiresAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
};

type MemoryLink = PersistedLink;

function memoryKey(userId: string, provider: MusicProvider) {
  return `${userId}:${provider}`;
}

function normalizeProvider(input: string): MusicProvider | null {
  if (input === "spotify" || input === "deezer") return input;
  return null;
}

function computeStatus(link: { expiresAtMs: number | null } | null): ProviderLinkStatus {
  if (!link) return "not_linked";
  if (typeof link.expiresAtMs === "number" && Number.isFinite(link.expiresAtMs) && link.expiresAtMs <= Date.now()) {
    return "expired";
  }
  return "linked";
}

export class MusicAccountRepository {
  private readonly memoryLinks = new Map<string, MemoryLink>();

  private get dbEnabled() {
    const value = process.env.DATABASE_URL;
    return typeof value === "string" && value.trim().length > 0;
  }

  async upsertLink(input: {
    userId: string;
    provider: MusicProvider;
    providerUserId?: string | null;
    accessToken: string;
    refreshToken?: string | null;
    scope?: string | null;
    expiresAtMs?: number | null;
  }) {
    const accessToken = input.accessToken.trim();
    if (accessToken.length <= 0) {
      return null;
    }
    const nowMs = Date.now();
    const record: PersistedLink = {
      userId: input.userId,
      provider: input.provider,
      providerUserId: input.providerUserId?.trim() || null,
      accessToken,
      refreshToken: input.refreshToken?.trim() || null,
      scope: input.scope?.trim() || null,
      expiresAtMs:
        typeof input.expiresAtMs === "number" && Number.isFinite(input.expiresAtMs)
          ? Math.max(0, Math.floor(input.expiresAtMs))
          : null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };

    if (!this.dbEnabled) {
      const key = memoryKey(record.userId, record.provider);
      const existing = this.memoryLinks.get(key);
      this.memoryLinks.set(key, {
        ...record,
        createdAtMs: existing?.createdAtMs ?? nowMs,
        updatedAtMs: nowMs,
      });
      return { ...record };
    }

    const result = await pool.query<{
      user_id: string;
      provider: string;
      provider_user_id: string | null;
      access_token: string;
      refresh_token: string | null;
      scope: string | null;
      expires_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        insert into music_account_links
          (user_id, provider, provider_user_id, access_token, refresh_token, scope, expires_at)
        values
          ($1, $2, $3, $4, $5, $6, $7)
        on conflict (user_id, provider)
        do update set
          provider_user_id = excluded.provider_user_id,
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          scope = excluded.scope,
          expires_at = excluded.expires_at,
          updated_at = now()
        returning user_id, provider, provider_user_id, access_token, refresh_token, scope, expires_at, created_at, updated_at
      `,
      [
        record.userId,
        record.provider,
        record.providerUserId,
        encryptToken(record.accessToken),
        record.refreshToken ? encryptToken(record.refreshToken) : null,
        record.scope,
        record.expiresAtMs ? new Date(record.expiresAtMs) : null,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    const provider = normalizeProvider(row.provider);
    if (!provider) return null;
    const access = decryptToken(row.access_token);
    if (!access) return null;
    return {
      userId: row.user_id,
      provider,
      providerUserId: row.provider_user_id,
      accessToken: access,
      refreshToken: decryptToken(row.refresh_token) ?? null,
      scope: row.scope,
      expiresAtMs: row.expires_at ? row.expires_at.getTime() : null,
      createdAtMs: row.created_at.getTime(),
      updatedAtMs: row.updated_at.getTime(),
    } satisfies PersistedLink;
  }

  async getLink(userId: string, provider: MusicProvider) {
    if (!this.dbEnabled) {
      const value = this.memoryLinks.get(memoryKey(userId, provider)) ?? null;
      return value ? { ...value } : null;
    }

    const result = await pool.query<{
      user_id: string;
      provider: string;
      provider_user_id: string | null;
      access_token: string;
      refresh_token: string | null;
      scope: string | null;
      expires_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        select user_id, provider, provider_user_id, access_token, refresh_token, scope, expires_at, created_at, updated_at
        from music_account_links
        where user_id = $1 and provider = $2
        limit 1
      `,
      [userId, provider],
    );
    const row = result.rows[0];
    if (!row) return null;
    const normalized = normalizeProvider(row.provider);
    if (!normalized) return null;
    const accessToken = decryptToken(row.access_token);
    if (!accessToken) return null;
    return {
      userId: row.user_id,
      provider: normalized,
      providerUserId: row.provider_user_id,
      accessToken,
      refreshToken: decryptToken(row.refresh_token),
      scope: row.scope,
      expiresAtMs: row.expires_at ? row.expires_at.getTime() : null,
      createdAtMs: row.created_at.getTime(),
      updatedAtMs: row.updated_at.getTime(),
    } satisfies PersistedLink;
  }

  async deleteLink(userId: string, provider: MusicProvider) {
    if (!this.dbEnabled) {
      this.memoryLinks.delete(memoryKey(userId, provider));
      return { ok: true as const };
    }
    await pool.query(
      `
        delete from music_account_links
        where user_id = $1 and provider = $2
      `,
      [userId, provider],
    );
    return { ok: true as const };
  }

  async listLinkStatuses(userId: string) {
    const spotify = await this.getLink(userId, "spotify");
    const deezer = await this.getLink(userId, "deezer");
    return {
      spotify: {
        status: computeStatus(spotify),
      },
      deezer: {
        status: computeStatus(deezer),
      },
    } satisfies Record<MusicProvider, { status: ProviderLinkStatus }>;
  }
}

export const musicAccountRepository = new MusicAccountRepository();
