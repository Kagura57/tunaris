import { betterAuth } from "better-auth";
import { pool } from "../db/client";

const FALLBACK_SECRET = "tunaris-dev-secret-change-this-in-production-1234";

export const auth = betterAuth({
  database: pool,
  basePath: "/auth",
  secret: process.env.BETTER_AUTH_SECRET ?? FALLBACK_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3001",
  emailAndPassword: {
    enabled: true,
  },
});
