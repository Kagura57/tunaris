import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("room play anime mode", () => {
  it("shows anime answer placeholder and media shell anime video layer", () => {
    const file = readFileSync("apps/web/src/routes/room/$roomCode/play.tsx", "utf8");
    expect(file).toContain("Nom de l'anime");
    expect(file).toContain("media-shell");
    expect(file).toContain("anime-video-layer");
    expect(file).toContain("Chargement de la video");
    expect(file).toContain("failedAnimeTrackKeyRef");
    expect(file).toContain("video.removeAttribute(\"src\")");
    expect(file).toContain("anilist_union");
  });
});
