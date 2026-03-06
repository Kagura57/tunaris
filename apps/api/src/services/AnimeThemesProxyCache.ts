import { mkdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pool } from "../db/client";

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [150, 300];
const DEFAULT_CACHE_DIR = join(tmpdir(), "kwizik-anime-themes-cache");

export type AnimeThemesProxyManifestEntry = {
  filePath: string;
  contentType: string;
  contentLength: number;
  etag: string | null;
  lastModified: string | null;
  cacheControl: string | null;
  warmedAtMs: number;
};

type AnimeThemesProxyCacheDependencies = {
  cacheDir?: string;
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  resolveVideoUrl?: (videoKey: string) => Promise<string | null>;
};

type OpenAnimeThemeVideoOptions = {
  rangeHeader?: string | null;
  ifRangeHeader?: string | null;
  signal?: AbortSignal;
};

type ParsedRange =
  | {
      start: number;
      end: number;
    }
  | {
      error: "unsatisfiable";
    };

export class AnimeThemesProxyError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "VIDEO_NOT_FOUND"
      | "UPSTREAM_UNREACHABLE"
      | "UPSTREAM_BAD_STATUS",
    readonly status: number,
    readonly body: string | null = null,
  ) {
    super(code);
  }
}

function safeCacheFileName(videoKey: string) {
  return videoKey.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function parseContentLength(raw: string | null, fallback: number) {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseRangeHeader(rangeHeader: string, contentLength: number): ParsedRange | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";

  if (startRaw.length === 0 && endRaw.length === 0) {
    return null;
  }

  if (startRaw.length === 0) {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { error: "unsatisfiable" };
    }
    const start = Math.max(0, contentLength - suffixLength);
    return { start, end: Math.max(start, contentLength - 1) };
  }

  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0 || start >= contentLength) {
    return { error: "unsatisfiable" };
  }

  if (endRaw.length === 0) {
    return { start, end: contentLength - 1 };
  }

  const requestedEnd = Number(endRaw);
  if (!Number.isFinite(requestedEnd) || requestedEnd < start) {
    return { error: "unsatisfiable" };
  }

  return { start, end: Math.min(contentLength - 1, requestedEnd) };
}

function matchesIfRange(ifRangeHeader: string | null | undefined, entry: AnimeThemesProxyManifestEntry) {
  if (!ifRangeHeader) return true;
  const candidate = ifRangeHeader.trim();
  if (!candidate) return true;
  if (entry.etag) return candidate === entry.etag;
  if (entry.lastModified) return candidate === entry.lastModified;
  return false;
}

async function cancelBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore retry cleanup failures.
  }
}

async function defaultResolveVideoUrl(videoKey: string) {
  if (!(typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim().length > 0)) {
    throw new AnimeThemesProxyError("DATABASE_UNAVAILABLE", 503);
  }

  const target = await pool.query<{ webm_url: string }>(
    `
      select webm_url
      from anime_theme_videos
      where video_key = $1
      limit 1
    `,
    [videoKey],
  );
  const webmUrl = target.rows[0]?.webm_url?.trim() ?? "";
  if (!webmUrl || !/^https?:\/\//i.test(webmUrl)) {
    return null;
  }
  return webmUrl;
}

export class AnimeThemesProxyCache {
  private readonly cacheDir: string;
  private readonly fetcher: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly resolveVideoUrl: (videoKey: string) => Promise<string | null>;
  private readonly inflight = new Map<string, Promise<AnimeThemesProxyManifestEntry>>();
  private readonly manifest = new Map<string, AnimeThemesProxyManifestEntry>();

  constructor(dependencies: AnimeThemesProxyCacheDependencies = {}) {
    this.cacheDir = dependencies.cacheDir ?? DEFAULT_CACHE_DIR;
    this.fetcher = dependencies.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.now = dependencies.now ?? (() => Date.now());
    this.resolveVideoUrl = dependencies.resolveVideoUrl ?? defaultResolveVideoUrl;
  }

  peek(videoKey: string) {
    return this.manifest.get(videoKey) ?? null;
  }

  async clear() {
    this.inflight.clear();
    this.manifest.clear();
    await rm(this.cacheDir, { recursive: true, force: true });
  }

  private async fetchWithRetries(webmUrl: string, signal?: AbortSignal) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await this.fetcher(webmUrl, {
          method: "GET",
          headers: {
            accept: "video/webm,*/*",
          },
          signal,
        });
        if (!RETRYABLE_STATUSES.has(response.status) || attempt === RETRY_DELAYS_MS.length) {
          return response;
        }
        await cancelBody(response);
      } catch (error) {
        if (signal?.aborted || attempt === RETRY_DELAYS_MS.length) {
          throw error;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt] ?? 0));
    }

    throw new AnimeThemesProxyError("UPSTREAM_UNREACHABLE", 502);
  }

  private async resolveManifest(videoKey: string) {
    const entry = this.manifest.get(videoKey);
    if (!entry) return null;
    try {
      const info = await stat(entry.filePath);
      if (!info.isFile() || info.size <= 0) {
        this.manifest.delete(videoKey);
        return null;
      }
      if (entry.contentLength !== info.size) {
        const nextEntry = { ...entry, contentLength: info.size };
        this.manifest.set(videoKey, nextEntry);
        return nextEntry;
      }
      return entry;
    } catch {
      this.manifest.delete(videoKey);
      return null;
    }
  }

  private async download(videoKey: string, webmUrl: string, signal?: AbortSignal) {
    await mkdir(this.cacheDir, { recursive: true });

    let response: Response;
    try {
      response = await this.fetchWithRetries(webmUrl, signal);
    } catch {
      throw new AnimeThemesProxyError("UPSTREAM_UNREACHABLE", 502);
    }

    if (response.status !== 200) {
      const body = await response.text().catch(() => null);
      throw new AnimeThemesProxyError("UPSTREAM_BAD_STATUS", response.status, body);
    }

    const tempPath = join(this.cacheDir, `${safeCacheFileName(videoKey)}.${randomUUID()}.part`);
    const finalPath = join(this.cacheDir, safeCacheFileName(videoKey));
    const writtenBytes = await Bun.write(tempPath, response);
    await rm(finalPath, { force: true });
    await rename(tempPath, finalPath);

    const entry: AnimeThemesProxyManifestEntry = {
      filePath: finalPath,
      contentType: response.headers.get("content-type")?.trim() || "video/webm",
      contentLength: parseContentLength(response.headers.get("content-length"), Number(writtenBytes)),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      cacheControl: response.headers.get("cache-control"),
      warmedAtMs: this.now(),
    };
    this.manifest.set(videoKey, entry);
    return entry;
  }

  async warm(videoKey: string, webmUrl: string, options: { signal?: AbortSignal } = {}) {
    const cached = await this.resolveManifest(videoKey);
    if (cached) return cached;

    const inflight = this.inflight.get(videoKey);
    if (inflight) return inflight;

    const promise = this.download(videoKey, webmUrl, options.signal).finally(() => {
      this.inflight.delete(videoKey);
    });
    this.inflight.set(videoKey, promise);
    return promise;
  }

  async warmByVideoKey(videoKey: string, options: { signal?: AbortSignal } = {}) {
    const cached = await this.resolveManifest(videoKey);
    if (cached) return cached;

    const inflight = this.inflight.get(videoKey);
    if (inflight) return inflight;

    const webmUrl = await this.resolveVideoUrl(videoKey);
    if (!webmUrl) {
      throw new AnimeThemesProxyError("VIDEO_NOT_FOUND", 404);
    }
    return this.warm(videoKey, webmUrl, options);
  }

  private buildLocalResponse(entry: AnimeThemesProxyManifestEntry, options: OpenAnimeThemeVideoOptions) {
    const headers = new Headers();
    headers.set("content-type", entry.contentType);
    headers.set("accept-ranges", "bytes");
    headers.set("x-kwizik-media-proxy", "animethemes");
    headers.set("x-kwizik-media-cache", "shared");
    if (entry.cacheControl) headers.set("cache-control", entry.cacheControl);
    if (entry.etag) headers.set("etag", entry.etag);
    if (entry.lastModified) headers.set("last-modified", entry.lastModified);

    const allowRange = matchesIfRange(options.ifRangeHeader, entry);
    const parsedRange =
      allowRange && options.rangeHeader ? parseRangeHeader(options.rangeHeader, entry.contentLength) : null;

    if (parsedRange?.error === "unsatisfiable") {
      headers.set("content-range", `bytes */${entry.contentLength}`);
      return new Response(null, {
        status: 416,
        headers,
      });
    }

    if (parsedRange && "start" in parsedRange) {
      const { start, end } = parsedRange;
      headers.set("content-length", String(end - start + 1));
      headers.set("content-range", `bytes ${start}-${end}/${entry.contentLength}`);
      return new Response(Bun.file(entry.filePath).slice(start, end + 1), {
        status: 206,
        headers,
      });
    }

    headers.set("content-length", String(entry.contentLength));
    return new Response(Bun.file(entry.filePath), {
      status: 200,
      headers,
    });
  }

  async open(videoKey: string, webmUrl: string, options: OpenAnimeThemeVideoOptions = {}) {
    const entry = (await this.resolveManifest(videoKey)) ?? (await this.warm(videoKey, webmUrl, options));
    return this.buildLocalResponse(entry, options);
  }

  async openByVideoKey(videoKey: string, options: OpenAnimeThemeVideoOptions = {}) {
    const entry = await this.resolveManifest(videoKey);
    if (entry) {
      return this.buildLocalResponse(entry, options);
    }

    const webmUrl = await this.resolveVideoUrl(videoKey);
    if (!webmUrl) {
      throw new AnimeThemesProxyError("VIDEO_NOT_FOUND", 404);
    }
    return this.open(videoKey, webmUrl, options);
  }
}

export const animeThemesProxyCache = new AnimeThemesProxyCache();
