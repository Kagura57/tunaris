import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as envModule from "../src/lib/env";
import { resetYouTubeSearchBackoffForTests, searchYouTube } from "../src/routes/music/youtube";

const readEnvVarMock = vi.fn<(key: string) => string | undefined>();

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("youtube key rotation", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    readEnvVarMock.mockReset();
    vi.spyOn(envModule, "readEnvVar").mockImplementation((key: string) => readEnvVarMock(key));
    resetYouTubeSearchBackoffForTests();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rotates to next API key when first key fails", async () => {
    readEnvVarMock.mockImplementation((key) => {
      if (key === "YOUTUBE_API_KEYS") return "bad-key,good-key";
      return undefined;
    });

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const key = url.searchParams.get("key");
      if (key === "bad-key") {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 403,
                message: "quotaExceeded",
              },
            },
            403,
          ),
        );
      }

      return Promise.resolve(
        jsonResponse({
          items: [
            {
              id: { videoId: "yt-rotated" },
              snippet: {
                title: "Rotated Song",
                channelTitle: "Rotated Artist",
              },
            },
          ],
        }),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tracks = await searchYouTube("rotated query", 5);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      provider: "youtube",
      id: "yt-rotated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches query results to avoid repeated API calls", async () => {
    readEnvVarMock.mockImplementation((key) => {
      if (key === "YOUTUBE_API_KEY") return "single-key";
      return undefined;
    });

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: { videoId: "yt-cache-query" },
            snippet: {
              title: "Cached Song",
              channelTitle: "Cached Artist",
            },
          },
        ],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await searchYouTube("cache me", 3);
    const second = await searchYouTube("cache me", 3);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to invidious when API key calls fail", async () => {
    readEnvVarMock.mockImplementation((key) => {
      if (key === "YOUTUBE_API_KEY") return "quota-key";
      if (key === "YOUTUBE_INVIDIOUS_INSTANCES") return "https://inv.example";
      return undefined;
    });

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname.includes("googleapis.com")) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 403,
                message: "quotaExceeded",
              },
            },
            403,
          ),
        );
      }

      if (url.hostname === "inv.example" && url.pathname === "/api/v1/search") {
        return Promise.resolve(
          jsonResponse([
            {
              type: "video",
              videoId: "inv-track-1",
              title: "Invidious Song",
              author: "Invidious Artist",
            },
          ]),
        );
      }

      return Promise.resolve(jsonResponse({}, 404));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tracks = await searchYouTube("quota fallback", 5);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      provider: "youtube",
      id: "inv-track-1",
      title: "Invidious Song",
      artist: "Invidious Artist",
    });
  });

  it("falls back to default invidious instances when API key fails and no instances are configured", async () => {
    readEnvVarMock.mockImplementation((key) => {
      if (key === "YOUTUBE_API_KEY") return "quota-key";
      return undefined;
    });

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname.includes("googleapis.com")) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 403,
                message: "quotaExceeded",
              },
            },
            403,
          ),
        );
      }

      if (url.hostname === "yewtu.be" && url.pathname === "/api/v1/search") {
        return Promise.resolve(
          jsonResponse([
            {
              type: "video",
              videoId: "default-inv-1",
              title: "Default Invidious Song",
              author: "Fallback Artist",
            },
          ]),
        );
      }

      return Promise.resolve(jsonResponse({}, 404));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tracks = await searchYouTube("quota default fallback", 5);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      provider: "youtube",
      id: "default-inv-1",
      title: "Default Invidious Song",
      artist: "Fallback Artist",
    });
  });

  it("falls back to ytmusic endpoint when configured and youtube api keys fail", async () => {
    readEnvVarMock.mockImplementation((key) => {
      if (key === "YOUTUBE_API_KEY") return "quota-key";
      if (key === "YTMUSIC_SEARCH_URL") return "https://ytmusic-proxy.example/search";
      return undefined;
    });

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname.includes("googleapis.com")) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 403,
                message: "quotaExceeded",
              },
            },
            403,
          ),
        );
      }

      if (url.hostname === "ytmusic-proxy.example" && url.pathname === "/search") {
        return Promise.resolve(
          jsonResponse({
            tracks: [
              {
                videoId: "ytmusic-001",
                title: "Bridge Song",
                artist: "Bridge Artist",
              },
            ],
          }),
        );
      }

      return Promise.resolve(jsonResponse({}, 404));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tracks = await searchYouTube("ytmusic bridge", 5);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      provider: "youtube",
      id: "ytmusic-001",
      title: "Bridge Song",
      artist: "Bridge Artist",
    });
  });

  it("falls back to youtube web search and oembed when no API key is configured", async () => {
    readEnvVarMock.mockImplementation((key) => {
      if (key === "YOUTUBE_INVIDIOUS_INSTANCES") return "https://inv-empty.example";
      return undefined;
    });

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "inv-empty.example" && url.pathname === "/api/v1/search") {
        return Promise.resolve(jsonResponse([]));
      }

      if (url.hostname === "www.youtube.com" && url.pathname === "/results") {
        return Promise.resolve(
          new Response(
            '<html><body>"videoId":"webvideo001","videoId":"webvideo001","videoId":"webvideo002"</body></html>',
            { status: 200, headers: { "content-type": "text/html" } },
          ),
        );
      }

      if (url.hostname === "www.youtube.com" && url.pathname === "/oembed") {
        const target = new URL(url.searchParams.get("url") ?? "");
        const id = target.searchParams.get("v");
        return Promise.resolve(
          jsonResponse({
            title: `Web Title ${id}`,
            author_name: "Web Artist",
          }),
        );
      }

      return Promise.resolve(jsonResponse({}, 404));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tracks = await searchYouTube("no key fallback", 2);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({
      provider: "youtube",
      id: "webvideo001",
      title: "Web Title webvideo001",
      artist: "Web Artist",
    });
    expect(tracks[1]).toMatchObject({
      provider: "youtube",
      id: "webvideo002",
      title: "Web Title webvideo002",
      artist: "Web Artist",
    });
  });

  it("does not invent synthetic youtube tracks when oembed lookup fails", async () => {
    readEnvVarMock.mockImplementation((key) => {
      if (key === "YOUTUBE_INVIDIOUS_INSTANCES") return "https://inv-empty.example";
      return undefined;
    });

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "inv-empty.example" && url.pathname === "/api/v1/search") {
        return Promise.resolve(jsonResponse([]));
      }

      if (url.hostname === "www.youtube.com" && url.pathname === "/results") {
        return Promise.resolve(
          new Response('<html><body>"videoId":"webvideo001"</body></html>', {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        );
      }

      if (url.hostname === "www.youtube.com" && url.pathname === "/oembed") {
        return Promise.resolve(jsonResponse({}, 404));
      }

      return Promise.resolve(jsonResponse({}, 404));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tracks = await searchYouTube("no synthetic", 3);
    expect(tracks).toEqual([]);
  });

  it("still attempts fallback during api backoff even when fallback backoff is active", async () => {
    readEnvVarMock.mockImplementation((key) => {
      if (key === "YOUTUBE_API_KEY") return "quota-key";
      if (key === "YOUTUBE_INVIDIOUS_INSTANCES") return "https://inv.example";
      return undefined;
    });

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (url.hostname.includes("googleapis.com")) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 403,
                message: "quotaExceeded",
              },
            },
            403,
          ),
        );
      }

      if (url.hostname === "inv.example" && url.pathname === "/api/v1/search") {
        const query = url.searchParams.get("q");
        if (query === "prime backoff") return Promise.resolve(jsonResponse([]));
        if (query === "recover during api backoff") {
          return Promise.resolve(
            jsonResponse([
              {
                type: "video",
                videoId: "inv-recover-1",
                title: "Recovered Song",
                author: "Recovered Artist",
              },
            ]),
          );
        }
        return Promise.resolve(jsonResponse([]));
      }

      if (url.hostname === "www.youtube.com" && url.pathname === "/results") {
        return Promise.resolve(new Response("<html><body></body></html>", { status: 200 }));
      }

      if (url.hostname === "www.youtube.com" && url.pathname === "/oembed") {
        return Promise.resolve(jsonResponse({}, 404));
      }

      return Promise.resolve(jsonResponse({}, 404));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const primed = await searchYouTube("prime backoff", 5);
    expect(primed).toEqual([]);

    const recovered = await searchYouTube("recover during api backoff", 5);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      provider: "youtube",
      id: "inv-recover-1",
      title: "Recovered Song",
      artist: "Recovered Artist",
    });
  });

  it("uses short miss cache ttl while youtube api is unavailable so same-query retries can recover", async () => {
    readEnvVarMock.mockImplementation((key) => {
      if (key === "YOUTUBE_API_KEY") return "quota-key";
      if (key === "YOUTUBE_INVIDIOUS_INSTANCES") return "https://inv.example";
      return undefined;
    });

    let nowMs = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let invidiousAttempts = 0;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname.includes("googleapis.com")) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 403,
                message: "quotaExceeded",
              },
            },
            403,
          ),
        );
      }

      if (url.hostname === "inv.example" && url.pathname === "/api/v1/search") {
        invidiousAttempts += 1;
        if (invidiousAttempts === 1) return Promise.resolve(jsonResponse([]));
        return Promise.resolve(
          jsonResponse([
            {
              type: "video",
              videoId: "inv-retry-1",
              title: "Retry Success",
              author: "Retry Artist",
            },
          ]),
        );
      }

      if (url.hostname === "www.youtube.com" && url.pathname === "/results") {
        return Promise.resolve(new Response("<html><body></body></html>", { status: 200 }));
      }

      if (url.hostname === "www.youtube.com" && url.pathname === "/oembed") {
        return Promise.resolve(jsonResponse({}, 404));
      }

      return Promise.resolve(jsonResponse({}, 404));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await searchYouTube("same query transient miss", 5);
    expect(first).toEqual([]);

    nowMs += 4_000;
    const second = await searchYouTube("same query transient miss", 5);
    expect(second).toEqual([]);

    nowMs += 1_500;
    const third = await searchYouTube("same query transient miss", 5);
    expect(third).toHaveLength(1);
    expect(third[0]).toMatchObject({
      provider: "youtube",
      id: "inv-retry-1",
      title: "Retry Success",
      artist: "Retry Artist",
    });
  });

  it("skips invidious fallback when YOUTUBE_DISABLE_INVIDIOUS is enabled", async () => {
    readEnvVarMock.mockImplementation((key) => {
      if (key === "YOUTUBE_API_KEY") return "quota-key";
      if (key === "YOUTUBE_DISABLE_INVIDIOUS") return "1";
      return undefined;
    });

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname.includes("googleapis.com")) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 403,
                message: "quotaExceeded",
              },
            },
            403,
          ),
        );
      }

      if (url.hostname === "www.youtube.com" && url.pathname === "/results") {
        return Promise.resolve(
          new Response('<html><body>"videoId":"webvideo123"</body></html>', {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        );
      }

      if (url.hostname === "www.youtube.com" && url.pathname === "/oembed") {
        return Promise.resolve(
          jsonResponse({
            title: "Web Only Song",
            author_name: "Web Only Artist",
          }),
        );
      }

      return Promise.resolve(jsonResponse({}, 404));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tracks = await searchYouTube("web only mode", 5);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      provider: "youtube",
      id: "webvideo123",
      title: "Web Only Song",
      artist: "Web Only Artist",
    });

    const calledUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(calledUrls.some((url) => url.includes("/api/v1/search"))).toBe(false);
  });
});
