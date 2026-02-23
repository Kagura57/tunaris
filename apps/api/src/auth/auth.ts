import { betterAuth } from "better-auth";
import { pool } from "../db/client";

const FALLBACK_SECRET = "tunaris-dev-secret-change-this-in-production-1234";

function normalizeOrigin(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function readBaseUrl() {
  return normalizeOrigin(process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3001");
}

function readTrustedOrigins() {
  const candidates = [
    readBaseUrl(),
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
  ];
  const rawExtra = process.env.BETTER_AUTH_TRUSTED_ORIGINS?.trim() ?? "";
  if (rawExtra.length > 0) {
    for (const entry of rawExtra.split(",")) {
      const normalized = normalizeOrigin(entry);
      if (normalized.length > 0) candidates.push(normalized);
    }
  }
  return Array.from(new Set(candidates));
}

export const auth = betterAuth({
  database: pool,
  basePath: "/auth",
  secret: process.env.BETTER_AUTH_SECRET ?? FALLBACK_SECRET,
  baseURL: readBaseUrl(),
  trustedOrigins: readTrustedOrigins(),
  emailAndPassword: {
    enabled: true,
  },
});
