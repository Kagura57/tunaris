import { describe, expect, it } from "vitest";
import { RoomStore } from "../src/services/RoomStore";
import type { MusicTrack } from "../src/services/music-types";

const FIXTURE_TRACKS: MusicTrack[] = [
  {
    provider: "youtube",
    id: "t1",
    title: "Alpha Song",
    artist: "Neon Waves",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=t1",
  },
  {
    provider: "youtube",
    id: "t2",
    title: "Beta Lights",
    artist: "City Echo",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=t2",
  },
];

const YOUTUBE_ONLY_TRACKS: MusicTrack[] = [
  {
    provider: "youtube",
    id: "yt1",
    title: "Skyline",
    artist: "Future Echo",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=yt1",
  },
];

describe("RoomStore gameplay progression", () => {
  it("runs countdown -> playing -> reveal -> leaderboard -> results and applies streak scoring", async () => {
    let nowMs = 0;
    const store = new RoomStore({
      now: () => nowMs,
      getTrackPool: async () => FIXTURE_TRACKS,
      config: {
        countdownMs: 10,
        playingMs: 100,
        revealMs: 10,
        leaderboardMs: 10,
        baseScore: 1_000,
        maxRounds: 2,
      },
    });

    const created = store.createRoom();
    const host = store.joinRoom(created.roomCode, "Host");
    const guest = store.joinRoom(created.roomCode, "Guest");

    expect(host.status).toBe("ok");
    expect(guest.status).toBe("ok");
    if (host.status !== "ok" || guest.status !== "ok") return;

    await store.startGame(created.roomCode, "popular hits");
    expect(store.roomState(created.roomCode)?.state).toBe("countdown");

    nowMs = 10;
    const playingRound1 = store.roomState(created.roomCode);
    expect(playingRound1?.state).toBe("playing");
    expect(playingRound1?.round).toBe(1);
    expect(playingRound1?.mode).toBe("mcq");
    expect((playingRound1?.choices ?? []).length).toBe(4);
    expect(playingRound1?.previewUrl).toBeNull();
    expect(playingRound1?.media?.provider).toBe("youtube");
    const round1Track = FIXTURE_TRACKS.find((track) => track.id === playingRound1?.media?.trackId);
    expect(round1Track).toBeDefined();
    expect(playingRound1?.media?.sourceUrl).toBe(round1Track?.sourceUrl);

    nowMs = 20;
    store.submitAnswer(
      created.roomCode,
      host.value.playerId,
      `${round1Track?.title ?? ""} - ${round1Track?.artist ?? ""}`,
    );
    nowMs = 40;
    store.submitAnswer(created.roomCode, guest.value.playerId, "wrong title");

    nowMs = 110;
    const revealRound1 = store.roomState(created.roomCode);
    expect(revealRound1?.state).toBe("reveal");
    expect(revealRound1?.reveal?.title).toBe(round1Track?.title);
    expect(revealRound1?.previewUrl).toBeNull();
    expect(revealRound1?.reveal?.sourceUrl).toBe(round1Track?.sourceUrl);
    expect(revealRound1?.reveal?.embedUrl).toContain(
      `youtube.com/embed/${round1Track?.id ?? ""}`,
    );

    nowMs = 120;
    const leaderboardRound1 = store.roomState(created.roomCode);
    expect(leaderboardRound1?.state).toBe("leaderboard");
    expect((leaderboardRound1?.leaderboard ?? []).length).toBe(2);

    nowMs = 130;
    const playingRound2 = store.roomState(created.roomCode);
    expect(playingRound2?.state).toBe("playing");
    expect(playingRound2?.round).toBe(2);
    expect(playingRound2?.mode).toBe("text");
    const round2Track = FIXTURE_TRACKS.find((track) => track.id === playingRound2?.media?.trackId);
    expect(round2Track).toBeDefined();

    nowMs = 150;
    store.submitAnswer(created.roomCode, host.value.playerId, round2Track?.artist ?? "");

    nowMs = 230;
    expect(store.roomState(created.roomCode)?.state).toBe("reveal");

    nowMs = 240;
    expect(store.roomState(created.roomCode)?.state).toBe("leaderboard");

    nowMs = 250;
    expect(store.roomState(created.roomCode)?.state).toBe("results");

    const results = store.roomResults(created.roomCode);
    expect(results?.state).toBe("results");
    expect(results?.ranking).toHaveLength(2);

    const winner = results?.ranking[0];
    const loser = results?.ranking[1];

    expect(winner?.displayName).toBe("Host");
    expect(winner?.maxStreak).toBe(2);
    expect((winner?.score ?? 0) > 0).toBe(true);
    expect(loser?.displayName).toBe("Guest");
    expect(loser?.score).toBe(0);
  });

  it("resets streak when a player misses a round", async () => {
    let nowMs = 0;
    const store = new RoomStore({
      now: () => nowMs,
      getTrackPool: async () => FIXTURE_TRACKS,
      config: {
        countdownMs: 5,
        playingMs: 50,
        revealMs: 5,
        leaderboardMs: 5,
        baseScore: 1_000,
        maxRounds: 2,
      },
    });

    const { roomCode } = store.createRoom();
    const player = store.joinRoom(roomCode, "Solo");
    expect(player.status).toBe("ok");
    if (player.status !== "ok") return;

    await store.startGame(roomCode, "popular hits");

    nowMs = 5;
    store.roomState(roomCode);
    nowMs = 10;
    store.submitAnswer(roomCode, player.value.playerId, "Alpha Song - Neon Waves");

    nowMs = 55;
    store.roomState(roomCode);
    nowMs = 60;
    store.roomState(roomCode);

    nowMs = 110;
    store.roomState(roomCode);
    nowMs = 115;
    store.roomState(roomCode);

    nowMs = 120;
    store.roomState(roomCode);

    const results = store.roomResults(roomCode);
    expect(results?.ranking).toHaveLength(1);
    expect(results?.ranking[0]?.maxStreak).toBe(1);
  });

  it("accepts youtube tracks without preview as playable rounds", async () => {
    let nowMs = 0;
    const store = new RoomStore({
      now: () => nowMs,
      getTrackPool: async () => YOUTUBE_ONLY_TRACKS,
      config: {
        countdownMs: 5,
        playingMs: 50,
        revealMs: 5,
        leaderboardMs: 5,
        baseScore: 1_000,
        maxRounds: 1,
      },
    });

    const { roomCode } = store.createRoom();
    const player = store.joinRoom(roomCode, "Solo");
    expect(player.status).toBe("ok");
    if (player.status !== "ok") return;

    const started = await store.startGame(roomCode, "youtube focus");
    expect(started?.ok).toBe(true);
    expect(started && "totalRounds" in started ? started.totalRounds : 0).toBe(1);

    nowMs = 5;
    const playing = store.roomState(roomCode);
    expect(playing?.state).toBe("playing");
    expect(playing?.previewUrl).toBeNull();
    expect(playing?.media?.provider).toBe("youtube");
    expect(playing?.media?.embedUrl).toContain("youtube.com/embed/yt1");
  });

  it("rejects late joins once room leaves setup", async () => {
    let nowMs = 0;
    const store = new RoomStore({
      now: () => nowMs,
      getTrackPool: async () => FIXTURE_TRACKS,
      config: {
        countdownMs: 5,
        playingMs: 50,
        revealMs: 5,
        leaderboardMs: 5,
        maxRounds: 1,
      },
    });

    const { roomCode } = store.createRoom();
    const host = store.joinRoom(roomCode, "Host");
    expect(host.status).toBe("ok");
    if (host.status !== "ok") return;

    await store.startGame(roomCode, "spotify:popular");
    const lateJoin = store.joinRoom(roomCode, "LatePlayer");
    expect(lateJoin.status).toBe("room_not_joinable");
  });
});
