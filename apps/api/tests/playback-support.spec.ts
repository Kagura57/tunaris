import { describe, expect, it } from "vitest";
import { hasYouTubePlayback, isTrackPlayable } from "../src/services/PlaybackSupport";

describe("playback support", () => {
  it("accepts youtube provider as playable", () => {
    const playable = isTrackPlayable({
      provider: "youtube",
      previewUrl: null,
      sourceUrl: "https://www.youtube.com/watch?v=abc123",
    });
    expect(playable).toBe(true);
  });

  it("accepts youtube url even when provider is not youtube", () => {
    const playable = hasYouTubePlayback({
      provider: "spotify",
      sourceUrl: "https://www.youtube.com/watch?v=xyz789",
    });
    expect(playable).toBe(true);
  });

  it("rejects non-youtube preview-only tracks", () => {
    const playable = isTrackPlayable({
      provider: "deezer",
      previewUrl: "https://cdn.deezer.com/preview.mp3",
      sourceUrl: "https://www.deezer.com/track/123",
    });
    expect(playable).toBe(false);
  });

  it("accepts animethemes webm tracks as playable", () => {
    const playable = isTrackPlayable({
      provider: "animethemes",
      previewUrl: null,
      sourceUrl: "https://v.animethemes.moe/ShingekiNoKyojin-OP1.webm",
    });
    expect(playable).toBe(true);
  });
});
