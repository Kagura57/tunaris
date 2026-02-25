import { afterEach, describe, expect, it, vi } from "vitest";
import * as queueModule from "../src/services/jobs/spotify-sync-queue";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("spotify sync queue enqueue behavior", () => {
  it("removes completed job before enqueueing a fresh one", async () => {
    const remove = vi.fn(async () => undefined);
    const getState = vi.fn(async () => "completed");
    const existingJob = { getState, remove } as unknown as {
      getState: () => Promise<string>;
      remove: () => Promise<void>;
    };
    const add = vi.fn(async () => ({ id: "fresh-job" }));
    const getJob = vi.fn(async () => existingJob);

    vi.spyOn(queueModule, "getSpotifySyncQueue").mockReturnValue({
      getJob,
      add,
    } as unknown as ReturnType<typeof queueModule.getSpotifySyncQueue>);

    const job = await queueModule.enqueueSpotifyLibrarySyncJob("user-1");
    expect(getJob).toHaveBeenCalled();
    expect(getState).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
    expect(add).toHaveBeenCalled();
    expect(job?.id).toBe("fresh-job");
  });
});
