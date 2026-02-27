import { describe, expect, it } from "vitest";
import { buildAniListSyncJobId } from "../src/services/jobs/anilist-sync-queue";

describe("anilist sync queue", () => {
  it("builds deterministic job id", () => {
    expect(buildAniListSyncJobId("user:42")).toBe("anilist-sync-user_42");
  });
});
