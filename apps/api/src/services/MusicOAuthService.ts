import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { fetchJsonWithTimeout } from "../routes/music/http";
import { logEvent } from "../lib/logger";
import { musicAccountRepository, type MusicProvider } from "../repositories/MusicAccountRepository";

type PendingOAuthState = {
  userId: string;
  provider: MusicProvider;
  returnTo: string | null;
  expiresAtMs: number;
};

const OAUTH_STATE_TTL_MS = 10 * 60_000;
const oauthStates = new Map<string, PendingOAuthState>();

function cleanupExpiredStates() {
  const now = Date.now();
  for (const [key, value] of oauthStates) {
    if (value.expiresAtMs <= now) {
      oauthStates.delete(key);
    }
  }
}

function createState() {
  cleanupExpiredStates();
  return randomBytes(16).toString("hex");
}

function readApiBaseUrl() {
  const raw = process.env.BETTER_AUTH_URL?.trim();
  if (raw && raw.length > 0) return raw.replace(/\/+$/, "");
  return "http://127.0.0.1:3001";
}

function readSpotifyConfig() {
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim() ?? "";
  if (!clientId || !clientSecret) return null;
  const redirectUri =
    process.env.SPOTIFY_OAUTH_REDIRECT_URI?.trim() ||
    `${readApiBaseUrl()}/account/music/spotify/connect/callback`;
  const scopes = [
    "user-library-read",
    "playlist-read-private",
    "playlist-read-collaborative",
  ].join(" ");
  return {
    clientId,
    clientSecret,
    redirectUri,
    scopes,
  };
}

function readDeezerConfig() {
  const appId = process.env.DEEZER_APP_ID?.trim() ?? "";
  const appSecret = process.env.DEEZER_APP_SECRET?.trim() ?? "";
  if (!appId || !appSecret) return null;
  const redirectUri =
    process.env.DEEZER_OAUTH_REDIRECT_URI?.trim() ||
    `${readApiBaseUrl()}/account/music/deezer/connect/callback`;
  const perms = ["basic_access", "manage_library", "offline_access"].join(",");
  return {
    appId,
    appSecret,
    redirectUri,
    perms,
  };
}

export function buildMusicConnectUrl(input: {
  provider: MusicProvider;
  userId: string;
  returnTo?: string | null;
}) {
  const state = createState();
  oauthStates.set(state, {
    userId: input.userId,
    provider: input.provider,
    returnTo: input.returnTo?.trim() || null,
    expiresAtMs: Date.now() + OAUTH_STATE_TTL_MS,
  });

  if (input.provider === "spotify") {
    const config = readSpotifyConfig();
    if (!config) return null;
    const url = new URL("https://accounts.spotify.com/authorize");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("scope", config.scopes);
    url.searchParams.set("state", state);
    url.searchParams.set("show_dialog", "true");
    return { url: url.toString(), state };
  }

  const config = readDeezerConfig();
  if (!config) return null;
  const url = new URL("https://connect.deezer.com/oauth/auth.php");
  url.searchParams.set("app_id", config.appId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("perms", config.perms);
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

function consumeOAuthState(state: string, provider: MusicProvider) {
  cleanupExpiredStates();
  const pending = oauthStates.get(state);
  if (!pending) return null;
  oauthStates.delete(state);
  if (pending.provider !== provider) return null;
  if (pending.expiresAtMs <= Date.now()) return null;
  return pending;
}

async function exchangeSpotifyCode(code: string) {
  const config = readSpotifyConfig();
  if (!config) return null;
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", config.redirectUri);
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const payload = (await fetchJsonWithTimeout(
    "https://accounts.spotify.com/api/token",
    {
      method: "POST",
      headers: {
        authorization: `Basic ${basicAuth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
    {
      timeoutMs: 6_000,
      retries: 1,
      context: {
        provider: "spotify",
        route: "oauth_user_token",
      },
    },
  )) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  } | null;
  if (!payload?.access_token) return null;

  const me = (await fetchJsonWithTimeout(
    "https://api.spotify.com/v1/me",
    {
      headers: {
        authorization: `Bearer ${payload.access_token}`,
      },
    },
    {
      timeoutMs: 6_000,
      retries: 1,
      context: {
        provider: "spotify",
        route: "oauth_user_me",
      },
    },
  )) as { id?: string } | null;
  const providerUserId = me?.id?.trim() || null;
  const expiresAtMs =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? Date.now() + Math.max(60, payload.expires_in) * 1000
      : null;
  return {
    providerUserId,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    scope: payload.scope ?? null,
    expiresAtMs,
  };
}

async function exchangeDeezerCode(code: string) {
  const config = readDeezerConfig();
  if (!config) return null;
  const url = new URL("https://connect.deezer.com/oauth/access_token.php");
  url.searchParams.set("app_id", config.appId);
  url.searchParams.set("secret", config.appSecret);
  url.searchParams.set("code", code);
  url.searchParams.set("output", "json");
  const payload = (await fetchJsonWithTimeout(
    url,
    {},
    {
      timeoutMs: 6_000,
      retries: 1,
      context: {
        provider: "deezer",
        route: "oauth_user_token",
      },
    },
  )) as { access_token?: string; expires?: number } | null;
  const accessToken = payload?.access_token?.trim() ?? "";
  if (!accessToken) return null;
  const meUrl = new URL("https://api.deezer.com/user/me");
  meUrl.searchParams.set("access_token", accessToken);
  const me = (await fetchJsonWithTimeout(
    meUrl,
    {},
    {
      timeoutMs: 6_000,
      retries: 1,
      context: {
        provider: "deezer",
        route: "oauth_user_me",
      },
    },
  )) as { id?: number } | null;
  const providerUserId =
    typeof me?.id === "number" && Number.isFinite(me.id)
      ? String(me.id)
      : null;
  const expiresAtMs =
    typeof payload?.expires === "number" && Number.isFinite(payload.expires)
      ? Date.now() + Math.max(60, payload.expires) * 1000
      : null;
  return {
    providerUserId,
    accessToken,
    refreshToken: null,
    scope: "basic_access,manage_library,offline_access",
    expiresAtMs,
  };
}

export async function handleMusicOAuthCallback(input: {
  provider: MusicProvider;
  code: string;
  state: string;
}) {
  const pending = consumeOAuthState(input.state, input.provider);
  if (!pending) {
    return {
      ok: false as const,
      error: "INVALID_STATE" as const,
      returnTo: null,
    };
  }

  const tokenPayload = input.provider === "spotify"
    ? await exchangeSpotifyCode(input.code)
    : await exchangeDeezerCode(input.code);
  if (!tokenPayload?.accessToken) {
    return {
      ok: false as const,
      error: "TOKEN_EXCHANGE_FAILED" as const,
      returnTo: pending.returnTo,
    };
  }

  await musicAccountRepository.upsertLink({
    userId: pending.userId,
    provider: input.provider,
    providerUserId: tokenPayload.providerUserId,
    accessToken: tokenPayload.accessToken,
    refreshToken: tokenPayload.refreshToken,
    scope: tokenPayload.scope,
    expiresAtMs: tokenPayload.expiresAtMs,
  });
  logEvent("info", "music_oauth_connected", {
    provider: input.provider,
    userId: pending.userId,
    providerUserId: tokenPayload.providerUserId,
  });
  return {
    ok: true as const,
    returnTo: pending.returnTo,
  };
}
