import { expect, test, type Page } from "@playwright/test";

function buildAnimeSnapshot(phase: "loading" | "playing") {
  const now = Date.now();
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
    guessDoneCount: 0,
    guessTotalCount: 1,
    mediaReadyCount: 0,
    mediaReadyTotalCount: 1,
    revealSkipCount: 0,
    revealSkipTotalCount: 1,
    previewUrl: "http://127.0.0.1:3001/quiz/media/animethemes/demo-track.webm",
    media: {
      provider: "animethemes" as const,
      trackId: "demo-track.webm",
      sourceUrl: "http://127.0.0.1:3001/quiz/media/animethemes/demo-track.webm",
      embedUrl: null,
    },
    nextMedia: null,
    reveal: null,
    leaderboard: [],
    chatMessages: [],
    answerSuggestions: ["Attack on Titan"],
  };
}

async function stubRoomApis(page: Page, phase: "loading" | "playing") {
  await page.route("**/api/auth/get-session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: null, session: null }),
    });
  });

  await page.route("**/api/realtime/room/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        roomCode: "ABC123",
        snapshot: buildAnimeSnapshot(phase),
        serverNowMs: Date.now(),
      }),
    });
  });

  await page.route("**/room/**/state", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildAnimeSnapshot(phase)),
    });
  });
}

test("play screen shows a toast when anime playback fails repeatedly", async ({ page }) => {
  await stubRoomApis(page, "loading");

  await page.goto("/room/ABC123/play");

  const video = page.locator("video.anime-video-layer");
  await expect(video).toHaveCount(1);

  const videoHandle = await video.elementHandle();
  if (!videoHandle) {
    throw new Error("anime video element not found");
  }
  await videoHandle.evaluate((node) => {
    node.dispatchEvent(new Event("error"));
    node.dispatchEvent(new Event("error"));
    node.dispatchEvent(new Event("error"));
  });

  await expect(
    page.getByText("Lecture du theme impossible. Passage automatique au round suivant..."),
  ).toBeVisible();
});

test("projection screen shows a toast when the current track fails", async ({ page }) => {
  await stubRoomApis(page, "playing");

  await page.goto("/room/ABC123/view");

  const video = page.locator("video.anime-video-layer");
  await expect(video).toBeVisible();

  await video.dispatchEvent("error");

  await expect(page.getByText("Lecture video impossible sur l'ecran de projection.")).toBeVisible();
});
