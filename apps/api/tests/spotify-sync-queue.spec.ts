import { describe, expect, it } from "vitest";
import { buildSpotifySyncJobId } from "../src/services/jobs/spotify-sync-queue";

describe("spotify sync queue job id", () => {
  it("builds a bullmq-compatible job id without colon", () => {
    const id = buildSpotifySyncJobId("user:abc@example.com");
    expect(id.includes(":")).toBe(false);
    expect(id).toBe("spotify-sync-user_abc_example_com");
  });
});
