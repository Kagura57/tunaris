import { describe, expect, it } from "vitest";
import { RoomStore } from "../src/services/RoomStore";
import type { MusicTrack } from "../src/services/music-types";

const ANIME_TRACKS: MusicTrack[] = [
  {
    provider: "youtube",
    id: "yt-aot-op1",
    title: "Guren no Yumiya",
    artist: "Linked Horizon",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=yt-aot-op1",
    answer: {
      canonical: "Attack on Titan",
      aliases: ["Shingeki no Kyojin", "AOT"],
      mode: "anime",
    },
  },
  {
    provider: "youtube",
    id: "yt-fmab-op1",
    title: "Again",
    artist: "YUI",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=yt-fmab-op1",
    answer: {
      canonical: "Fullmetal Alchemist: Brotherhood",
      aliases: ["FMAB"],
      mode: "anime",
    },
  },
  {
    provider: "youtube",
    id: "yt-sao-op1",
    title: "Crossing Field",
    artist: "LiSA",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=yt-sao-op1",
    answer: {
      canonical: "Sword Art Online",
      aliases: ["SAO"],
      mode: "anime",
    },
  },
  {
    provider: "youtube",
    id: "yt-ds-op1",
    title: "Gurenge",
    artist: "LiSA",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=yt-ds-op1",
    answer: {
      canonical: "Demon Slayer",
      aliases: ["Kimetsu no Yaiba"],
      mode: "anime",
    },
  },
];

describe("anime round payload", () => {
  it("uses anime canonical title as reveal accepted answer", async () => {
    let nowMs = 0;
    const store = new RoomStore({
      now: () => nowMs,
      getTrackPool: async () => ANIME_TRACKS,
      config: {
        maxRounds: 1,
        countdownMs: 5,
        playingMs: 20,
        revealMs: 5,
        leaderboardMs: 5,
      },
    });

    const created = store.createRoom();
    const host = store.joinRoom(created.roomCode, "Host");
    expect(host.status).toBe("ok");
    if (host.status !== "ok") return;

    const sourceMode = store.setRoomSourceMode(created.roomCode, host.value.playerId, "anime");
    expect(sourceMode.status).toBe("ok");
    const sourceSet = store.setRoomSource(created.roomCode, host.value.playerId, "anilist:users:demo-user");
    expect(sourceSet.status).toBe("ok");
    const ready = store.setPlayerReady(created.roomCode, host.value.playerId, true);
    expect(ready.status).toBe("ok");

    const started = await store.startGame(created.roomCode, host.value.playerId);
    expect(started).toMatchObject({ ok: true, sourceMode: "anime" });

    nowMs = 5;
    const playing = store.roomState(created.roomCode);
    expect(playing?.state).toBe("playing");
    expect(playing?.mode).toBe("mcq");
    const picked = playing?.choices?.[0] ?? "";
    store.submitAnswer(created.roomCode, host.value.playerId, picked);

    nowMs = 26;
    const reveal = store.roomState(created.roomCode);
    expect(reveal?.state).toBe("reveal");
    expect(reveal?.reveal?.acceptedAnswer).toBeTruthy();
    expect(reveal?.reveal?.acceptedAnswer.includes(" - ")).toBe(false);
  });
});
