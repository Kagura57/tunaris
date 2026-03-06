import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("room play anime mode", () => {
  it("keeps anime playback tolerant and preloads the next animethemes track on the player page", () => {
    const file = readFileSync("apps/web/src/routes/room/$roomCode/play.tsx", "utf8");
    expect(file).toContain("Nom de l'anime");
    expect(file).toContain("media-shell");
    expect(file).toContain("anime-video-layer");
    expect(file).toContain("Chargement de la video");
    expect(file).toContain("failedAnimeTrackKeyRef");
    expect(file).toContain("video.removeAttribute(\"src\")");
    expect(file).toContain("anilist_union");
    expect(file).toContain("ANIME_MEDIA_EXTREME_TIMEOUT_MS");
    expect(file).toContain("ANIME_MEDIA_LONG_LOAD_TOAST_MS");
    expect(file).toContain('state?.nextMedia?.provider === "animethemes"');
    expect(file).toContain("data-kwizik-next-anime-preload");
    expect(file).not.toContain("ANIME_MEDIA_ERROR_THRESHOLD = 3");
  });
});
