import { Pool } from "pg";

export const DOMAIN_TABLES = [
  "profiles",
  "matches",
  "match_participants",
  "rounds",
  "round_submissions",
  "provider_tracks",
  "resolved_tracks",
  "user_liked_tracks",
  "user_library_syncs",
  "music_account_links",
] as const;

export const AUTH_TABLES = [
  "user",
  "session",
  "account",
  "verification",
] as const;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
