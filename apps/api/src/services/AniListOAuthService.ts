import { Buffer } from "node:buffer";
import { pool } from "../db/client";
import { decryptToken, encryptToken } from "../lib/token-cipher";

type OAuthStatePayload = {
  u: string;
  r: string | null;
};

type AniListTokenPayload = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
};

type AniListViewerPayload = {
  data?: {
    Viewer?: {
      id?: number;
      name?: string;
    };
  };
};

type PersistedLink = {
  userId: string;
  anilistUserId: string | null;
  anilistUsername: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number | null;
  scope: string | null;
  updatedAtMs: number;
};

const memoryLinks = new Map<string, PersistedLink>();

function isDbEnabled() {
  const value = process.env.DATABASE_URL;
  return typeof value === "string" && value.trim().length > 0;
}

function readClientConfig() {
  const clientId = process.env.ANILIST_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.ANILIST_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = process.env.ANILIST_REDIRECT_URI?.trim() ?? "";
  if (!clientId || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

function compact(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function safeParseState(rawState: string) {
  try {
    const decoded = Buffer.from(rawState, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as Partial<OAuthStatePayload>;
    const userId = typeof parsed.u === "string" ? parsed.u.trim() : "";
    const returnTo = typeof parsed.r === "string" ? parsed.r.trim() : null;
    if (!userId) return null;
    return {
      userId,
      returnTo,
    };
  } catch {
    return null;
  }
}

export function buildAniListConnectUrl(input: { userId: string; returnTo?: string | null }) {
  const config = readClientConfig();
  if (!config) return null;

  const payload: OAuthStatePayload = {
    u: input.userId,
    r: compact(input.returnTo),
  };
  const state = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const url = new URL("https://anilist.co/api/v2/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);

  return {
    url: url.toString(),
    state,
  };
}

async function exchangeCodeForToken(code: string) {
  const config = readClientConfig();
  if (!config || !config.clientSecret) return null;
  const response = await fetch("https://anilist.co/api/v2/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code,
    }),
  });
  if (!response.ok) return null;
  return (await response.json()) as AniListTokenPayload;
}

async function fetchAniListViewer(accessToken: string) {
  const response = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: `query { Viewer { id name } }`,
    }),
  });
  if (!response.ok) return { anilistUserId: null, anilistUsername: null };
  const payload = (await response.json()) as AniListViewerPayload;
  const id = payload.data?.Viewer?.id;
  const name = payload.data?.Viewer?.name;
  return {
    anilistUserId: typeof id === "number" && Number.isFinite(id) ? String(id) : null,
    anilistUsername: compact(name),
  };
}

async function upsertAniListLink(input: {
  userId: string;
  anilistUserId: string | null;
  anilistUsername: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number | null;
  scope: string | null;
}) {
  const record: PersistedLink = {
    userId: input.userId,
    anilistUserId: input.anilistUserId,
    anilistUsername: input.anilistUsername,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAtMs: input.expiresAtMs,
    scope: input.scope,
    updatedAtMs: Date.now(),
  };

  if (!isDbEnabled()) {
    memoryLinks.set(input.userId, record);
    return record;
  }

  await pool.query(
    `
      insert into anilist_account_links
        (user_id, anilist_user_id, anilist_username, access_token, refresh_token, expires_at, scope, updated_at)
      values
        ($1, $2, $3, $4, $5, $6, $7, now())
      on conflict (user_id)
      do update set
        anilist_user_id = excluded.anilist_user_id,
        anilist_username = excluded.anilist_username,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        scope = excluded.scope,
        updated_at = now()
    `,
    [
      input.userId,
      input.anilistUserId,
      input.anilistUsername,
      encryptToken(input.accessToken),
      input.refreshToken ? encryptToken(input.refreshToken) : null,
      input.expiresAtMs ? new Date(input.expiresAtMs) : null,
      input.scope,
    ],
  );

  return record;
}

export async function handleAniListOAuthCallback(input: { code: string; state: string }) {
  const parsedState = safeParseState(input.state);
  if (!parsedState) {
    return { ok: false as const, returnTo: null as string | null, userId: null as string | null };
  }

  const token = await exchangeCodeForToken(input.code);
  const accessToken = compact(token?.access_token);
  if (!accessToken) {
    return {
      ok: false as const,
      returnTo: parsedState.returnTo,
      userId: parsedState.userId,
    };
  }

  const viewer = await fetchAniListViewer(accessToken);
  const expiresAtMs =
    typeof token?.expires_in === "number" && Number.isFinite(token.expires_in)
      ? Date.now() + Math.max(60, token.expires_in) * 1000
      : null;

  await upsertAniListLink({
    userId: parsedState.userId,
    anilistUserId: viewer.anilistUserId,
    anilistUsername: viewer.anilistUsername,
    accessToken,
    refreshToken: compact(token?.refresh_token),
    expiresAtMs,
    scope: null,
  });

  return {
    ok: true as const,
    returnTo: parsedState.returnTo,
    userId: parsedState.userId,
  };
}

export async function getAniListLinkForUser(userId: string) {
  const key = userId.trim();
  if (!key) return null;
  if (!isDbEnabled()) {
    return memoryLinks.get(key) ?? null;
  }

  const result = await pool.query<{
    user_id: string;
    anilist_user_id: string | null;
    anilist_username: string | null;
    access_token: string;
    refresh_token: string | null;
    expires_at: Date | null;
    scope: string | null;
    updated_at: Date;
  }>(
    `
      select user_id, anilist_user_id, anilist_username, access_token, refresh_token, expires_at, scope, updated_at
      from anilist_account_links
      where user_id = $1
      limit 1
    `,
    [key],
  );

  const row = result.rows[0];
  if (!row) return null;
  const accessToken = decryptToken(row.access_token);
  if (!accessToken) return null;
  return {
    userId: row.user_id,
    anilistUserId: row.anilist_user_id,
    anilistUsername: row.anilist_username,
    accessToken,
    refreshToken: decryptToken(row.refresh_token),
    expiresAtMs: row.expires_at ? row.expires_at.getTime() : null,
    scope: row.scope,
    updatedAtMs: row.updated_at.getTime(),
  } satisfies PersistedLink;
}
