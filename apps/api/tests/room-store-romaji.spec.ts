import { describe, expect, it, vi } from "vitest";

vi.mock("../src/services/JapaneseRomanizer", () => ({
  getRomanizedJapaneseCached: (value: string) => {
    const map: Record<string, string> = {
      "夜のドライブ": "yoru no doraibu",
      "光のシグナル": "hikari no shigunaru",
      "ミライ": "mirai",
      "ハルカ": "haruka",
    };
    return map[value] ?? null;
  },
  scheduleRomanizeJapanese: () => undefined,
}));

import { RoomStore } from "../src/services/RoomStore";
import type { MusicTrack } from "../src/services/music-types";

const JAPANESE_TRACKS: MusicTrack[] = [
  {
    provider: "youtube",
    id: "jp-1",
    title: "夜のドライブ",
    artist: "ミライ",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=jp-1",
  },
  {
    provider: "youtube",
    id: "jp-2",
    title: "光のシグナル",
    artist: "ハルカ",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=jp-2",
  },
];

describe("RoomStore romaji answer matching", () => {
  it("accepts text answers written in romaji for japanese tracks", async () => {
    let nowMs = 0;
    const store = new RoomStore({
      now: () => nowMs,
      getTrackPool: async () => JAPANESE_TRACKS,
      config: {
        countdownMs: 5,
        playingMs: 40,
        revealMs: 5,
        leaderboardMs: 5,
        baseScore: 1_000,
        maxRounds: 2,
      },
    });

    const created = store.createRoom();
    const player = store.joinRoom(created.roomCode, "Host");
    expect(player.status).toBe("ok");
    if (player.status !== "ok") return;

    const sourceSet = store.setRoomSource(created.roomCode, player.value.playerId, "jp test");
    expect(sourceSet.status).toBe("ok");
    const ready = store.setPlayerReady(created.roomCode, player.value.playerId, true);
    expect(ready.status).toBe("ok");
    const started = await store.startGame(created.roomCode, player.value.playerId);
    expect(started?.ok).toBe(true);

    nowMs = 5;
    const round1 = store.roomState(created.roomCode);
    expect(round1?.state).toBe("playing");
    expect(round1?.mode).toBe("mcq");
    const firstChoice = round1?.choices?.[0] ?? "";
    store.submitAnswer(created.roomCode, player.value.playerId, firstChoice);

    nowMs = 45;
    store.roomState(created.roomCode); // reveal round 1
    nowMs = 50;
    store.roomState(created.roomCode); // leaderboard round 1
    nowMs = 55;
    const round2 = store.roomState(created.roomCode);
    expect(round2?.state).toBe("playing");
    expect(round2?.mode).toBe("text");

    const round2Track = JAPANESE_TRACKS.find((track) => track.id === round2?.media?.trackId);
    expect(round2Track).toBeDefined();
    const romajiArtist = round2Track?.artist === "ミライ" ? "mirai" : "haruka";
    store.submitAnswer(created.roomCode, player.value.playerId, romajiArtist);

    nowMs = 95;
    store.roomState(created.roomCode); // reveal round 2, scoring done
    nowMs = 100;
    store.roomState(created.roomCode); // leaderboard round 2
    nowMs = 105;
    const results = store.roomResults(created.roomCode);

    expect(results?.state).toBe("results");
    expect((results?.ranking?.[0]?.score ?? 0) > 0).toBe(true);
  });
});
