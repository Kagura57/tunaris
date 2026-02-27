import { describe, expect, it } from "vitest";
import { normalizeAniListListStatus } from "../src/services/jobs/anilist-sync-worker";

describe("anilist sync worker", () => {
  it("maps anilist statuses to app statuses", () => {
    expect(normalizeAniListListStatus("CURRENT")).toBe("WATCHING");
    expect(normalizeAniListListStatus("COMPLETED")).toBe("COMPLETED");
    expect(normalizeAniListListStatus("PAUSED")).toBeNull();
  });
});
