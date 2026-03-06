import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnimeThemesProxyCache } from "../src/services/AnimeThemesProxyCache";

describe("AnimeThemesProxyCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deduplicates concurrent warm requests for the same video key", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "kwizik-anime-cache-test-"));
    const fetcher = vi.fn(async () => new Response("demo", { status: 200 }));
    const cache = new AnimeThemesProxyCache({ cacheDir, fetcher });

    await Promise.all([
      cache.warm("Bleach-OP12.webm", "https://cdn.example.test/Bleach-OP12.webm"),
      cache.warm("Bleach-OP12.webm", "https://cdn.example.test/Bleach-OP12.webm"),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const entry = cache.peek("Bleach-OP12.webm");
    expect(entry).not.toBeNull();
    expect(entry?.contentLength).toBe(4);
    if (entry) {
      expect(await stat(entry.filePath)).toEqual(
        expect.objectContaining({
          size: 4,
        }),
      );
      expect(await readFile(entry.filePath, "utf8")).toBe("demo");
    }

    await cache.clear();
  });

  it("serves byte ranges from the shared local file", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "kwizik-anime-cache-test-"));
    const cache = new AnimeThemesProxyCache({
      cacheDir,
      fetcher: async () =>
        new Response("shared-video", {
          status: 200,
          headers: {
            "content-type": "video/webm",
            "content-length": "12",
            etag: "\"demo-etag\"",
          },
        }),
    });

    const response = await cache.open("GoldenKamuy-OP1.webm", "https://cdn.example.test/GoldenKamuy-OP1.webm", {
      rangeHeader: "bytes=6-11",
      ifRangeHeader: "\"demo-etag\"",
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 6-11/12");
    expect(await response.text()).toBe("-video");

    await cache.clear();
  });
});
