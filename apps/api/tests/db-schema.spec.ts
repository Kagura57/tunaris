import { describe, expect, it } from "vitest";
import { AUTH_TABLES, DOMAIN_TABLES } from "../src/db/client";

describe("db schema contract", () => {
  it("declares blindtest domain tables", () => {
    expect(DOMAIN_TABLES).toContain("matches");
    expect(DOMAIN_TABLES).toContain("round_submissions");
  });

  it("declares Better Auth core tables", () => {
    expect(AUTH_TABLES).toContain("user");
    expect(AUTH_TABLES).toContain("session");
    expect(AUTH_TABLES).toContain("account");
    expect(AUTH_TABLES).toContain("verification");
  });
});
