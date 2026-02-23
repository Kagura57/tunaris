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

const PROMOTIONAL_MIXED_TRACKS: MusicTrack[] = [
  {
    provider: "youtube",
    id: "promo-1",
    title: "Spotify This App Best Free Music Alternative",
    artist: "Sunday Cal",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=promo-1",
  },
  {
    provider: "youtube",
    id: "clean-1",
    title: "Midnight Signal",
    artist: "Nova Tide",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=clean-1",
  },
  {
    provider: "youtube",
    id: "clean-2",
    title: "Silver Horizon",
    artist: "Nova Tide",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=clean-2",
  },
];

const MCQ_NO_REPEAT_DISTRACTOR_TRACKS: MusicTrack[] = [
  {
    provider: "youtube",
    id: "mcq-1",
    title: "Arcade Nova",
    artist: "Pulse Engine",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=mcq-1",
  },
  {
    provider: "youtube",
    id: "mcq-2",
    title: "Night Circuit",
    artist: "Solar Vibe",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=mcq-2",
  },
  {
    provider: "youtube",
    id: "mcq-3",
    title: "Chrome Drift",
    artist: "Echo Rally",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=mcq-3",
  },
  {
    provider: "youtube",
    id: "mcq-4",
    title: "Neon Axis",
    artist: "Delta Run",
    previewUrl: null,
    sourceUrl: "https://www.youtube.com/watch?v=mcq-4",
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

    const sourceSet = store.setRoomSource(created.roomCode, host.value.playerId, "popular hits");
    expect(sourceSet.status).toBe("ok");
    const hostReady = store.setPlayerReady(created.roomCode, host.value.playerId, true);
    const guestReady = store.setPlayerReady(created.roomCode, guest.value.playerId, true);
    expect(hostReady.status).toBe("ok");
    expect(guestReady.status).toBe("ok");
    await store.startGame(created.roomCode, host.value.playerId);
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

    const sourceSet = store.setRoomSource(roomCode, player.value.playerId, "popular hits");
    expect(sourceSet.status).toBe("ok");
    const ready = store.setPlayerReady(roomCode, player.value.playerId, true);
    expect(ready.status).toBe("ok");
    await store.startGame(roomCode, player.value.playerId);

    nowMs = 5;
    const playingRound1 = store.roomState(roomCode);
    const round1Track = FIXTURE_TRACKS.find((track) => track.id === playingRound1?.media?.trackId);
    nowMs = 10;
    store.submitAnswer(
      roomCode,
      player.value.playerId,
      `${round1Track?.title ?? ""} - ${round1Track?.artist ?? ""}`,
    );

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

  it("does not reuse previously-correct tracks as later MCQ distractors", async () => {
    let nowMs = 0;
    const store = new RoomStore({
      now: () => nowMs,
      getTrackPool: async () => MCQ_NO_REPEAT_DISTRACTOR_TRACKS,
      config: {
        countdownMs: 5,
        playingMs: 20,
        revealMs: 5,
        leaderboardMs: 5,
        maxRounds: 3,
      },
    });

    const { roomCode } = store.createRoom();
    const player = store.joinRoom(roomCode, "Host");
    expect(player.status).toBe("ok");
    if (player.status !== "ok") return;

    const sourceSet = store.setRoomSource(roomCode, player.value.playerId, "spotify:playlist:dummy");
    expect(sourceSet.status).toBe("ok");
    const ready = store.setPlayerReady(roomCode, player.value.playerId, true);
    expect(ready.status).toBe("ok");
    const started = await store.startGame(roomCode, player.value.playerId);
    expect(started?.ok).toBe(true);

    nowMs = 5;
    const round1Playing = store.roomState(roomCode);
    expect(round1Playing?.state).toBe("playing");
    expect(round1Playing?.mode).toBe("mcq");
    const round1Track = MCQ_NO_REPEAT_DISTRACTOR_TRACKS.find((track) => track.id === round1Playing?.media?.trackId);
    expect(round1Track).toBeDefined();
    const round1Label = `${round1Track?.title ?? ""} - ${round1Track?.artist ?? ""}`;

    nowMs = 30; // reveal round 1
    store.roomState(roomCode);
    nowMs = 35; // leaderboard round 1
    store.roomState(roomCode);
    nowMs = 40; // playing round 2 (text)
    const round2Playing = store.roomState(roomCode);
    expect(round2Playing?.state).toBe("playing");
    expect(round2Playing?.mode).toBe("text");

    nowMs = 65; // reveal round 2
    store.roomState(roomCode);
    nowMs = 70; // leaderboard round 2
    store.roomState(roomCode);
    nowMs = 75; // playing round 3 (mcq)
    const round3Playing = store.roomState(roomCode);
    expect(round3Playing?.state).toBe("playing");
    expect(round3Playing?.mode).toBe("mcq");
    expect(round3Playing?.choices?.includes(round1Label)).toBe(false);
  });

  it("always returns 4 unique MCQ choices even when distractors are scarce", async () => {
    let nowMs = 0;
    const singleTrack: MusicTrack[] = [
      {
        provider: "youtube",
        id: "solo-1",
        title: "Walking On A Dream",
        artist: "Empire Of The Sun",
        previewUrl: null,
        sourceUrl: "https://www.youtube.com/watch?v=solo-1",
      },
    ];
    const store = new RoomStore({
      now: () => nowMs,
      getTrackPool: async () => singleTrack,
      config: {
        countdownMs: 5,
        playingMs: 20,
        revealMs: 5,
        leaderboardMs: 5,
        maxRounds: 1,
      },
    });

    const { roomCode } = store.createRoom();
    const player = store.joinRoom(roomCode, "Host");
    expect(player.status).toBe("ok");
    if (player.status !== "ok") return;

    store.setRoomSource(roomCode, player.value.playerId, "spotify:playlist:dummy");
    store.setPlayerReady(roomCode, player.value.playerId, true);
    const started = await store.startGame(roomCode, player.value.playerId);
    expect(started).toMatchObject({ ok: true });

    nowMs = 5;
    const playing = store.roomState(roomCode);
    expect(playing?.state).toBe("playing");
    expect(playing?.mode).toBe("mcq");
    const choices = playing?.choices ?? [];
    expect(choices).toHaveLength(4);
    expect(new Set(choices).size).toBe(4);
    expect(
      choices.filter((choice) => choice === "Walking On A Dream - Empire Of The Sun"),
    ).toHaveLength(1);
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

    const sourceSet = store.setRoomSource(roomCode, player.value.playerId, "youtube focus");
    expect(sourceSet.status).toBe("ok");
    const ready = store.setPlayerReady(roomCode, player.value.playerId, true);
    expect(ready.status).toBe("ok");
    const started = await store.startGame(roomCode, player.value.playerId);
    expect(started?.ok).toBe(true);
    expect(started && "totalRounds" in started ? started.totalRounds : 0).toBe(1);

    nowMs = 5;
    const playing = store.roomState(roomCode);
    expect(playing?.state).toBe("playing");
    expect(playing?.previewUrl).toBeNull();
    expect(playing?.media?.provider).toBe("youtube");
    expect(playing?.media?.embedUrl).toContain("youtube.com/embed/yt1");
  });

  it("accepts late joins while game is running", async () => {
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

    const sourceSet = store.setRoomSource(roomCode, host.value.playerId, "spotify:popular");
    expect(sourceSet.status).toBe("ok");
    const ready = store.setPlayerReady(roomCode, host.value.playerId, true);
    expect(ready.status).toBe("ok");
    await store.startGame(roomCode, host.value.playerId);
    const lateJoin = store.joinRoom(roomCode, "LatePlayer");
    expect(lateJoin.status).toBe("ok");
    if (lateJoin.status !== "ok") return;
    expect(lateJoin.value.playerCount).toBe(2);
  });

  it("filters promotional tracks from pool before starting rounds", async () => {
    let nowMs = 0;
    const store = new RoomStore({
      now: () => nowMs,
      getTrackPool: async () => PROMOTIONAL_MIXED_TRACKS,
      config: {
        countdownMs: 5,
        playingMs: 50,
        revealMs: 5,
        leaderboardMs: 5,
        maxRounds: 2,
      },
    });

    const { roomCode } = store.createRoom();
    const player = store.joinRoom(roomCode, "Host");
    expect(player.status).toBe("ok");
    if (player.status !== "ok") return;

    const sourceSet = store.setRoomSource(roomCode, player.value.playerId, "deezer:playlist:3155776842");
    expect(sourceSet.status).toBe("ok");
    const ready = store.setPlayerReady(roomCode, player.value.playerId, true);
    expect(ready.status).toBe("ok");
    const started = await store.startGame(roomCode, player.value.playerId);
    expect(started?.ok).toBe(true);
    nowMs = 5;
    const playing = store.roomState(roomCode);
    expect(playing?.state).toBe("playing");
    const label = playing?.media?.trackId ?? "";
    expect(["clean-1", "clean-2"]).toContain(label);
  });

  it("requires host and 100% ready before start", async () => {
    const store = new RoomStore({
      getTrackPool: async () => FIXTURE_TRACKS,
      config: { maxRounds: 2 },
    });
    const created = store.createRoom();
    const host = store.joinRoom(created.roomCode, "Host");
    const guest = store.joinRoom(created.roomCode, "Guest");
    expect(host.status).toBe("ok");
    expect(guest.status).toBe("ok");
    if (host.status !== "ok" || guest.status !== "ok") return;

    const guestSource = store.setRoomSource(created.roomCode, guest.value.playerId, "popular hits");
    expect(guestSource.status).toBe("forbidden");

    const hostSource = store.setRoomSource(created.roomCode, host.value.playerId, "popular hits");
    expect(hostSource.status).toBe("ok");

    store.setPlayerReady(created.roomCode, host.value.playerId, true);
    const startedBeforeAllReady = await store.startGame(created.roomCode, host.value.playerId);
    expect(startedBeforeAllReady).toMatchObject({ ok: false, error: "PLAYERS_NOT_READY" });

    store.setPlayerReady(created.roomCode, guest.value.playerId, true);
    const started = await store.startGame(created.roomCode, host.value.playerId);
    expect(started?.ok).toBe(true);
  });

  it("supports replay to waiting lobby and preserves players", async () => {
    let nowMs = 0;
    const store = new RoomStore({
      now: () => nowMs,
      getTrackPool: async () => FIXTURE_TRACKS,
      config: {
        countdownMs: 5,
        playingMs: 20,
        revealMs: 5,
        leaderboardMs: 5,
        maxRounds: 1,
      },
    });
    const created = store.createRoom();
    const host = store.joinRoom(created.roomCode, "Host");
    const guest = store.joinRoom(created.roomCode, "Guest");
    expect(host.status).toBe("ok");
    expect(guest.status).toBe("ok");
    if (host.status !== "ok" || guest.status !== "ok") return;

    store.setRoomSource(created.roomCode, host.value.playerId, "popular hits");
    store.setPlayerReady(created.roomCode, host.value.playerId, true);
    store.setPlayerReady(created.roomCode, guest.value.playerId, true);
    await store.startGame(created.roomCode, host.value.playerId);

    nowMs = 5;
    store.roomState(created.roomCode);
    nowMs = 25;
    store.roomState(created.roomCode);
    nowMs = 30;
    store.roomState(created.roomCode);
    nowMs = 35;
    store.roomState(created.roomCode);
    expect(store.roomState(created.roomCode)?.state).toBe("results");

    const replay = store.replayRoom(created.roomCode, host.value.playerId);
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.state).toBe("waiting");

    const lobby = store.roomState(created.roomCode);
    expect(lobby?.state).toBe("waiting");
    expect(lobby?.players).toHaveLength(2);
    expect(lobby?.categoryQuery).toBe("");
    expect(lobby?.readyCount).toBe(0);
  });

  it("starts only when the full requested round pool is prepared", async () => {
    let nowMs = 0;
    const requestedSizes: number[] = [];
    const makeTrack = (index: number): MusicTrack => ({
      provider: "youtube",
      id: `yt-${index}`,
      title: `Track ${index}`,
      artist: `Artist ${index}`,
      previewUrl: null,
      sourceUrl: `https://www.youtube.com/watch?v=yt-${index}`,
    });
    const store = new RoomStore({
      now: () => nowMs,
      getTrackPool: async (_query, size) => {
        requestedSizes.push(size);
        return Array.from({ length: size }, (_, index) => makeTrack(index + 1));
      },
      config: {
        maxRounds: 10,
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

    const sourceSet = store.setRoomSource(created.roomCode, host.value.playerId, "deezer:playlist:3155776842");
    expect(sourceSet.status).toBe("ok");
    const ready = store.setPlayerReady(created.roomCode, host.value.playerId, true);
    expect(ready.status).toBe("ok");
    const started = await store.startGame(created.roomCode, host.value.playerId);
    expect(started).toMatchObject({ ok: true });
    expect((started && "poolSize" in started ? started.poolSize : 0)).toBe(10);
    expect((started && "totalRounds" in started ? started.totalRounds : 0)).toBe(10);
    expect(requestedSizes[0]).toBeGreaterThanOrEqual(10);

    nowMs = 5;
    const playing = store.roomState(created.roomCode);
    expect(playing?.state).toBe("playing");
    expect(playing?.mode).toBe("mcq");
    expect(playing?.choices).toHaveLength(4);
    expect((playing?.choices ?? []).some((choice) => choice.startsWith("Choix alternatif"))).toBe(false);
  });

  it("supports players_liked mode with linked provider contributions", async () => {
    const likedTracks: MusicTrack[] = Array.from({ length: 12 }, (_, index) => ({
      provider: "youtube",
      id: `liked-${index + 1}`,
      title: `Liked Track ${index + 1}`,
      artist: `Artist ${index + 1}`,
      previewUrl: null,
      sourceUrl: `https://www.youtube.com/watch?v=liked-${index + 1}`,
    }));
    const store = new RoomStore({
      getPlayerLikedTracks: async () => likedTracks,
      config: {
        maxRounds: 10,
        countdownMs: 5,
        playingMs: 20,
        revealMs: 5,
        leaderboardMs: 5,
      },
    });

    const created = store.createRoom();
    const host = store.joinRoomAsUser(
      created.roomCode,
      "Host",
      "user-host",
      { spotify: { status: "linked", estimatedTrackCount: 120 } },
    );
    const guest = store.joinRoom(created.roomCode, "Guest");
    if ("status" in host) return;
    if (guest.status !== "ok") return;

    const modeSet = store.setRoomSourceMode(created.roomCode, host.playerId, "players_liked");
    expect(modeSet.status).toBe("ok");
    const contribution = store.setPlayerLibraryContribution(
      created.roomCode,
      host.playerId,
      "spotify",
      true,
    );
    expect(contribution.status).toBe("ok");
    store.setPlayerReady(created.roomCode, host.playerId, true);
    store.setPlayerReady(created.roomCode, guest.value.playerId, true);

    const started = await store.startGame(created.roomCode, host.playerId);
    expect(started).toMatchObject({
      ok: true,
      sourceMode: "players_liked",
    });
  });

  it("blocks players_liked mode start when no linked contributor is opted-in", async () => {
    const store = new RoomStore({
      getPlayerLikedTracks: async () => [],
      config: {
        maxRounds: 5,
      },
    });
    const created = store.createRoom();
    const host = store.joinRoomAsUser(created.roomCode, "Host", "user-host");
    if ("status" in host) return;
    store.setRoomSourceMode(created.roomCode, host.playerId, "players_liked");
    store.setPlayerReady(created.roomCode, host.playerId, true);

    const started = await store.startGame(created.roomCode, host.playerId);
    expect(started).toMatchObject({
      ok: false,
      error: "PLAYERS_LIBRARY_NOT_READY",
    });
  });

  it("returns SPOTIFY_RATE_LIMITED when upstream spotify is throttled", async () => {
    const store = new RoomStore({
      getTrackPool: async () => {
        throw new Error("SPOTIFY_RATE_LIMITED");
      },
      config: {
        maxRounds: 10,
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

    const sourceSet = store.setRoomSource(created.roomCode, host.value.playerId, "spotify:playlist:abc123");
    expect(sourceSet.status).toBe("ok");
    const ready = store.setPlayerReady(created.roomCode, host.value.playerId, true);
    expect(ready.status).toBe("ok");

    const started = await store.startGame(created.roomCode, host.value.playerId);
    expect(started).toMatchObject({
      ok: false,
      error: "SPOTIFY_RATE_LIMITED",
    });
  });
});
