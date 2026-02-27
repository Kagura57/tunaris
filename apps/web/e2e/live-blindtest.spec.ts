import { expect, test } from "@playwright/test";

function buildSnapshot(phase: "playing" | "reveal") {
  const now = Date.now();
  const media = {
    provider: "animethemes" as const,
    trackId: "video-1",
    sourceUrl: "https://v.animethemes.moe/demo-track.webm",
    embedUrl: null,
  };

  return {
    roomCode: "ABC123",
    state: phase,
    round: 1,
    mode: "text" as const,
    choices: null,
    serverNowMs: now,
    playerCount: 1,
    hostPlayerId: "p1",
    players: [
      {
        playerId: "p1",
        displayName: "Host",
        isReady: true,
        hasAnsweredCurrentRound: false,
        isHost: true,
        canContributeLibrary: true,
        libraryContribution: {
          includeInPool: { spotify: false, deezer: false },
          linkedProviders: { spotify: "not_linked", deezer: "not_linked" },
          estimatedTrackCount: { spotify: 0, deezer: 0 },
          syncStatus: "ready",
          lastError: null,
        },
      },
    ],
    readyCount: 1,
    allReady: true,
    canStart: true,
    isResolvingTracks: false,
    poolSize: 10,
    categoryQuery: "anilist:linked:union",
    sourceMode: "anilist_union" as const,
    sourceConfig: {
      mode: "anilist_union" as const,
      themeMode: "mix" as const,
      publicPlaylist: null,
      playersLikedRules: { minContributors: 1, minTotalTracks: 1 },
    },
    poolBuild: {
      status: "ready" as const,
      contributorsCount: 1,
      mergedTracksCount: 20,
      playableTracksCount: 20,
      lastBuiltAtMs: now,
      errorCode: null,
    },
    totalRounds: 10,
    deadlineMs: now + 8_000,
    previewUrl: "https://v.animethemes.moe/demo-track.webm",
    media,
    reveal:
      phase === "reveal"
        ? {
            round: 1,
            trackId: "video-1",
            provider: "animethemes" as const,
            title: "Attack on Titan",
            titleRomaji: "Attack on Titan",
            artist: "OP1",
            artistRomaji: "OP1",
            acceptedAnswer: "Attack on Titan",
            mode: "text" as const,
            previewUrl: "https://v.animethemes.moe/demo-track.webm",
            sourceUrl: "https://v.animethemes.moe/demo-track.webm",
            embedUrl: null,
            playerAnswers: [],
          }
        : null,
    leaderboard: [],
    chatMessages: [],
    answerSuggestions: ["Attack on Titan", "AOT"],
  };
}

test("anime round keeps video hidden during guessing then reveals without restart", async ({ page }) => {
  let phase: "playing" | "reveal" = "playing";

  await page.route("**/realtime/room/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        roomCode: "ABC123",
        snapshot: buildSnapshot(phase),
        serverNowMs: Date.now(),
      }),
    });
  });

  await page.route("**/room/**/state", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildSnapshot(phase)),
    });
  });

  await page.goto("/room/ABC123/play");

  await expect(page.locator("video.anime-video-hidden")).toHaveCount(1);

  phase = "reveal";
  await expect.poll(async () => page.locator("video.anime-video-reveal").count()).toBeGreaterThan(0);
});
