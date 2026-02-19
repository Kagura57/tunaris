import { describe, expect, it } from "vitest";
import { DOMAIN_TABLES } from "../src/db/client";

describe("db schema contract", () => {
  it("declares blindtest domain tables", () => {
    expect(DOMAIN_TABLES).toContain("matches");
    expect(DOMAIN_TABLES).toContain("round_submissions");
  });
});
