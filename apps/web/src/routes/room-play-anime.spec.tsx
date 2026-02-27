import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("room play anime mode", () => {
  it("shows anime answer placeholder and hidden anime video class", () => {
    const file = readFileSync("apps/web/src/routes/room/$roomCode/play.tsx", "utf8");
    expect(file).toContain("Nom de l'anime");
    expect(file).toContain("anime-video-hidden");
    expect(file).toContain("anilist_union");
  });
});
