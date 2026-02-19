import { Pool } from "pg";

export const DOMAIN_TABLES = [
  "profiles",
  "matches",
  "match_participants",
  "rounds",
  "round_submissions",
  "provider_tracks",
] as const;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
