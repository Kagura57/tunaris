import { describe, expect, it } from "vitest";
import { parseTrackSource } from "../src/services/TrackSourceResolver";

describe("track source resolver", () => {
  it("parses spotify playlist source", () => {
    const parsed = parseTrackSource("spotify:playlist:37i9dQZEVXbMDoHDwVN2tF");
    expect(parsed.type).toBe("spotify_playlist");
    expect(parsed.payload).toEqual({ playlistId: "37i9dQZEVXbMDoHDwVN2tF" });
  });

  it("normalizes spotify playlist id from full URL", () => {
    const parsed = parseTrackSource(
      "spotify:playlist:https://open.spotify.com/playlist/37i9dQZEVXbMDoHDwVN2tF?si=abc123",
    );
    expect(parsed.type).toBe("spotify_playlist");
    expect(parsed.payload).toEqual({ playlistId: "37i9dQZEVXbMDoHDwVN2tF" });
  });

  it("normalizes deezer playlist id from full URL", () => {
    const parsed = parseTrackSource("deezer:playlist:https://www.deezer.com/fr/playlist/3155776842");
    expect(parsed.type).toBe("deezer_playlist");
    expect(parsed.payload).toEqual({ playlistId: "3155776842" });
  });

  it("parses anilist users source", () => {
    const parsed = parseTrackSource("anilist:users:alice,bob,charlie");
    expect(parsed.type).toBe("anilist_users");
    expect(parsed.payload).toEqual({ usernames: ["alice", "bob", "charlie"] });
  });

  it("falls back to free search source", () => {
    const parsed = parseTrackSource("anime openings");
    expect(parsed.type).toBe("search");
    expect(parsed.query).toBe("anime openings");
  });
});
