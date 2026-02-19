import { fetchJsonWithTimeout } from "./http";
import { readEnvVar } from "../../lib/env";
import { logEvent } from "../../lib/logger";

type SpotifyTokenPayload = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
};

type SpotifyTokenCache = {
  token: string;
  expiresAtMs: number;
};

let cachedToken: SpotifyTokenCache | null = null;

function normalizeAccessToken(raw: string | undefined) {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) return "";
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^bearer\s+/i, "").trim();
  }
  return trimmed;
}

function hasStaticToken() {
  return normalizeAccessToken(readEnvVar("SPOTIFY_ACCESS_TOKEN")).length > 0;
}

function readStaticToken() {
  return normalizeAccessToken(readEnvVar("SPOTIFY_ACCESS_TOKEN"));
}

function hasClientCredentials() {
  const clientId = readEnvVar("SPOTIFY_CLIENT_ID");
  const clientSecret = readEnvVar("SPOTIFY_CLIENT_SECRET");
  return Boolean(clientId && clientId.length > 0 && clientSecret && clientSecret.length > 0);
}

async function fetchClientCredentialsToken() {
  const clientId = readEnvVar("SPOTIFY_CLIENT_ID");
  const clientSecret = readEnvVar("SPOTIFY_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
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
      retryDelayMs: 350,
      context: {
        provider: "spotify",
        route: "oauth_token",
      },
    },
  )) as SpotifyTokenPayload | null;

  const token = payload?.access_token?.trim();
  if (!token) return null;

  const expiresInSec = Math.max(60, payload?.expires_in ?? 3600);
  return {
    token,
    expiresAtMs: Date.now() + (expiresInSec - 30) * 1_000,
  } satisfies SpotifyTokenCache;
}

export async function getSpotifyAccessToken() {
  const staticToken = hasStaticToken() ? readStaticToken() : null;
  const clientCredentialsEnabled = hasClientCredentials();

  if (clientCredentialsEnabled) {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAtMs > now) {
      return cachedToken.token;
    }

    const fresh = await fetchClientCredentialsToken();
    if (fresh) {
      cachedToken = fresh;
      return fresh.token;
    }

    if (staticToken) {
      logEvent("warn", "spotify_token_refresh_failed_using_static_token_fallback");
      return staticToken;
    }

    logEvent("warn", "spotify_token_refresh_failed");
    return null;
  }

  if (staticToken) {
    return staticToken;
  }

  if (!clientCredentialsEnabled) {
    logEvent("warn", "spotify_credentials_missing", {
      hasAccessToken: false,
      hasClientId: Boolean(readEnvVar("SPOTIFY_CLIENT_ID")),
      hasClientSecret: Boolean(readEnvVar("SPOTIFY_CLIENT_SECRET")),
    });
    return null;
  }
  return null;
}

export function spotifyAuthDiagnostics() {
  const hasStaticAccessToken = hasStaticToken();
  const hasCredentials = hasClientCredentials();
  return {
    hasStaticAccessToken,
    hasClientCredentials: hasCredentials,
    authMode: hasCredentials ? "client_credentials" : hasStaticAccessToken ? "static_token" : "missing",
    cachedTokenValid: Boolean(cachedToken && cachedToken.expiresAtMs > Date.now()),
    cachedTokenExpiresAt: cachedToken ? new Date(cachedToken.expiresAtMs).toISOString() : null,
  };
}

export function resetSpotifyTokenCacheForTests() {
  cachedToken = null;
}
