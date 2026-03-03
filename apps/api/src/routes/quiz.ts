import { Elysia } from "elysia";
import { readSessionFromHeaders } from "../auth/client";
import { musicAccountRepository } from "../repositories/MusicAccountRepository";
import { matchRepository } from "../repositories/MatchRepository";
import { profileRepository } from "../repositories/ProfileRepository";
import { userLikedTrackRepository } from "../repositories/UserLikedTrackRepository";
import { roomStore } from "../services/RoomStore";

function readStringField(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalStringField(body: unknown, key: string) {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalBooleanField(body: unknown, key: string) {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const value = record[key];
  if (typeof value === "boolean") return value;
  return null;
}

function readOptionalNumberField(body: unknown, key: string) {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export const quizRoutes = new Elysia({ prefix: "/quiz" })
  .post("/create", ({ body }) => {
    const categoryQuery = readOptionalStringField(body, "categoryQuery");
    const isPublic = readOptionalBooleanField(body, "isPublic");
    return roomStore.createRoom({
      categoryQuery: categoryQuery ?? undefined,
      isPublic: isPublic ?? undefined,
    });
  })
  .get("/public", () => ({
    ok: true as const,
    serverNowMs: Date.now(),
    rooms: roomStore.publicRooms(),
  }))
  .post("/join", async ({ body, headers, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const displayName = readStringField(body, "displayName");

    if (!roomCode || !displayName) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const authContext = await readSessionFromHeaders(headers as unknown as Headers);
    const linkedProviders = authContext?.user.id
      ? await musicAccountRepository.listLinkStatuses(authContext.user.id)
      : undefined;
    const syncedTrackCounts = authContext?.user.id
      ? await userLikedTrackRepository.countForUserByProvider(authContext.user.id)
      : undefined;
    const joined = roomStore.joinRoomAsUser(
      roomCode,
      displayName,
      authContext?.user.id ?? null,
      linkedProviders
        ? {
            spotify: {
              status: linkedProviders.spotify.status,
              estimatedTrackCount: syncedTrackCounts?.spotify ?? 0,
            },
            deezer: {
              status: linkedProviders.deezer.status,
              estimatedTrackCount: syncedTrackCounts?.deezer ?? 0,
            },
          }
        : undefined,
    );
    if ("status" in joined && joined.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if ("status" in joined && joined.status === "room_not_joinable") {
      set.status = 409;
      return { ok: false, error: "ROOM_NOT_JOINABLE" };
    }

    if (authContext?.user.id) {
      await profileRepository.upsertProfile({
        userId: authContext.user.id,
        displayName,
      });
    }

    return joined;
  })
  .post("/start", async ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    if (!roomCode) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }
    if (!playerId) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const started = await roomStore.startGame(roomCode, playerId);
    if (!started) {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }

    if (started.ok === false) {
      if (started.error === "SPOTIFY_RATE_LIMITED") {
        set.status = 429;
      } else if (started.error === "NO_TRACKS_FOUND") {
        set.status = 422;
      } else if (started.error === "PLAYERS_LIBRARY_SYNCING" || started.error === "PLAYLIST_TRACKS_RESOLVING") {
        set.status = 202;
      } else if (started.error === "PLAYERS_LIBRARY_NOT_READY") {
        set.status = 409;
      } else if (started.error === "PLAYER_NOT_FOUND") {
        set.status = 404;
      } else if (started.error === "HOST_ONLY") {
        set.status = 403;
      } else {
        set.status = 400;
      }
      return started;
    }

    return started;
  })
  .post("/source", ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    const categoryQuery = readStringField(body, "categoryQuery");
    if (!roomCode || !playerId || !categoryQuery) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const result = roomStore.setRoomSource(roomCode, playerId, categoryQuery);
    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }
    if (result.status === "forbidden") {
      set.status = 403;
      return { ok: false, error: "HOST_ONLY" };
    }
    if (result.status === "invalid_state") {
      set.status = 409;
      return { ok: false, error: "INVALID_STATE" };
    }
    if (result.status === "invalid_payload") {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }
    return { ok: true as const, categoryQuery: result.categoryQuery };
  })
  .post("/source/mode", ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    const mode = readStringField(body, "mode");
    if (!roomCode || !playerId || !mode) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }
    if (mode !== "public_playlist" && mode !== "players_liked" && mode !== "anilist_union") {
      set.status = 400;
      return { ok: false, error: "INVALID_MODE" };
    }
    const result = roomStore.setRoomSourceMode(roomCode, playerId, mode);
    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }
    if (result.status === "forbidden") {
      set.status = 403;
      return { ok: false, error: "HOST_ONLY" };
    }
    if (result.status === "invalid_state") {
      set.status = 409;
      return { ok: false, error: "INVALID_STATE" };
    }
    return { ok: true as const, mode: result.mode };
  })
  .post("/source/theme-mode", ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    const mode = readStringField(body, "mode");
    if (!roomCode || !playerId || !mode) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }
    if (mode !== "op_only" && mode !== "ed_only" && mode !== "mix") {
      set.status = 400;
      return { ok: false, error: "INVALID_MODE" };
    }
    const result = roomStore.setRoomThemeMode(roomCode, playerId, mode);
    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }
    if (result.status === "forbidden") {
      set.status = 403;
      return { ok: false, error: "HOST_ONLY" };
    }
    if (result.status === "invalid_state") {
      set.status = 409;
      return { ok: false, error: "INVALID_STATE" };
    }
    return { ok: true as const, mode: result.mode };
  })
  .post("/source/public-playlist", ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    const id = readStringField(body, "id");
    const name = readOptionalStringField(body, "name") ?? "";
    const sourceQuery = readOptionalStringField(body, "sourceQuery") ?? undefined;
    const trackCount = readOptionalNumberField(body, "trackCount");
    if (!roomCode || !playerId || !id) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }
    const result = roomStore.setRoomPublicPlaylist(roomCode, playerId, {
      id,
      name,
      sourceQuery,
      trackCount: trackCount ?? null,
    });
    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }
    if (result.status === "forbidden") {
      set.status = 403;
      return { ok: false, error: "HOST_ONLY" };
    }
    if (result.status === "invalid_state") {
      set.status = 409;
      return { ok: false, error: "INVALID_STATE" };
    }
    if (result.status === "invalid_payload") {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }
    return {
      ok: true as const,
      sourceMode: result.sourceMode,
      categoryQuery: result.categoryQuery,
    };
  })
  .post("/library/contribution", async ({ body, headers, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    const provider = readStringField(body, "provider");
    const includeInPool = readOptionalBooleanField(body, "includeInPool");
    if (!roomCode || !playerId || !provider || includeInPool === null) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }
    if (provider !== "spotify" && provider !== "deezer") {
      set.status = 400;
      return { ok: false, error: "INVALID_PROVIDER" };
    }
    const authContext = await readSessionFromHeaders(headers as unknown as Headers);
    if (!authContext?.user?.id) {
      set.status = 401;
      return { ok: false, error: "UNAUTHORIZED" };
    }
    const ownerUserId = roomStore.playerUserId(roomCode, playerId);
    if (!ownerUserId || ownerUserId !== authContext.user.id) {
      set.status = 403;
      return { ok: false, error: "FORBIDDEN" };
    }
    const result = roomStore.setPlayerLibraryContribution(roomCode, playerId, provider, includeInPool);
    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }
    if (result.status === "invalid_state") {
      set.status = 409;
      return { ok: false, error: "INVALID_STATE" };
    }
    if (result.status === "forbidden") {
      set.status = 403;
      return { ok: false, error: "FORBIDDEN" };
    }
    return {
      ok: true as const,
      includeInPool: result.includeInPool,
    };
  })
  .post("/library/refresh-links", async ({ body, headers, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    if (!roomCode || !playerId) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }
    const authContext = await readSessionFromHeaders(headers as unknown as Headers);
    if (!authContext?.user?.id) {
      set.status = 401;
      return { ok: false, error: "UNAUTHORIZED" };
    }
    const ownerUserId = roomStore.playerUserId(roomCode, playerId);
    if (!ownerUserId || ownerUserId !== authContext.user.id) {
      set.status = 403;
      return { ok: false, error: "FORBIDDEN" };
    }
    const links = await musicAccountRepository.listLinkStatuses(authContext.user.id);
    const syncedTrackCounts = await userLikedTrackRepository.countForUserByProvider(authContext.user.id);
    const synced = roomStore.setPlayerLibraryLinks(roomCode, playerId, {
      spotify: { status: links.spotify.status, estimatedTrackCount: syncedTrackCounts.spotify },
      deezer: { status: links.deezer.status, estimatedTrackCount: syncedTrackCounts.deezer },
    });
    if (synced.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (synced.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }
    return {
      ok: true as const,
      linkedProviders: synced.linkedProviders,
    };
  })
  .post("/ready", ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    const ready = readOptionalBooleanField(body, "ready");
    if (!roomCode || !playerId || ready === null) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const result = roomStore.setPlayerReady(roomCode, playerId, ready);
    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }
    if (result.status === "invalid_state") {
      set.status = 409;
      return { ok: false, error: "INVALID_STATE" };
    }
    return { ok: true as const, isReady: result.isReady };
  })
  .post("/kick", ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    const targetPlayerId = readStringField(body, "targetPlayerId");
    if (!roomCode || !playerId || !targetPlayerId) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const result = roomStore.kickPlayer(roomCode, playerId, targetPlayerId);
    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }
    if (result.status === "target_not_found") {
      set.status = 404;
      return { ok: false, error: "TARGET_NOT_FOUND" };
    }
    if (result.status === "forbidden") {
      set.status = 403;
      return { ok: false, error: "HOST_ONLY" };
    }
    if (result.status === "invalid_state") {
      set.status = 409;
      return { ok: false, error: "INVALID_STATE" };
    }
    if (result.status === "invalid_payload") {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }
    return { ok: true as const, playerCount: result.playerCount };
  })
  .post("/leave", ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    if (!roomCode || !playerId) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const result = roomStore.removePlayer(roomCode, playerId);
    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }
    return {
      ok: true as const,
      playerCount: result.playerCount,
      hostPlayerId: result.hostPlayerId,
    };
  })
  .post("/replay", ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    if (!roomCode || !playerId) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const result = roomStore.replayRoom(roomCode, playerId);
    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }
    if (result.status === "forbidden") {
      set.status = 403;
      return { ok: false, error: "HOST_ONLY" };
    }
    if (result.status === "invalid_state") {
      set.status = 409;
      return { ok: false, error: "INVALID_STATE" };
    }
    return {
      ok: true as const,
      roomCode: result.roomCode,
      state: result.state,
      playerCount: result.playerCount,
      categoryQuery: result.categoryQuery,
    };
  })
  .post("/skip", ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    if (!roomCode || !playerId) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const result = roomStore.skipCurrentRound(roomCode, playerId);
    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }
    if (result.status === "invalid_state") {
      set.status = 409;
      return { ok: false, error: "INVALID_STATE" };
    }

    return {
      ok: true as const,
      accepted: result.accepted,
      state: result.state,
      round: result.round,
      deadlineMs: result.deadlineMs,
    };
  })
  .post("/media/unavailable", async ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    const trackId = readStringField(body, "trackId");
    if (!roomCode || !playerId || !trackId) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const result = await roomStore.reportMediaUnavailable(roomCode, playerId, trackId);
    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }
    if (result.status === "invalid_state") {
      set.status = 409;
      return { ok: false, error: "INVALID_STATE" };
    }
    if (result.status === "invalid_payload") {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    return {
      ok: true as const,
      accepted: result.accepted,
      state: result.state,
      round: result.round,
      deadlineMs: result.deadlineMs,
    };
  })
  .post("/media/ready", ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    const trackId = readStringField(body, "trackId");
    if (!roomCode || !playerId || !trackId) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const result = roomStore.markMediaReady(roomCode, playerId, trackId);
    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }
    if (result.status === "invalid_state") {
      set.status = 409;
      return { ok: false, error: "INVALID_STATE" };
    }
    if (result.status === "invalid_payload") {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    return {
      ok: true as const,
      accepted: result.accepted,
      state: result.state,
      round: result.round,
      deadlineMs: result.deadlineMs,
    };
  })
  .post("/answer/draft", ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    const answer = readOptionalStringField(body, "answer") ?? "";

    if (!roomCode || !playerId) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const result = roomStore.submitDraftAnswer(roomCode, playerId, answer);

    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }

    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }

    return { accepted: result.accepted };
  })
  .post("/answer", ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    const answer = readStringField(body, "answer");

    if (!roomCode || !playerId || !answer) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const result = roomStore.submitAnswer(roomCode, playerId, answer);

    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }

    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }

    return { accepted: result.accepted };
  })
  .post("/chat/send", ({ body, set }) => {
    const roomCode = readStringField(body, "roomCode");
    const playerId = readStringField(body, "playerId");
    const text = readStringField(body, "text");

    if (!roomCode || !playerId || !text) {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const result = roomStore.postChatMessage(roomCode, playerId, text);
    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }
    if (result.status === "invalid_payload") {
      set.status = 400;
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    return {
      ok: true as const,
      message: result.message,
    };
  })
  .get("/answer-suggestions/:roomCode", async ({ params, query, set }) => {
    const playerId =
      typeof query === "object" && query !== null && typeof (query as Record<string, unknown>).playerId === "string"
        ? ((query as Record<string, unknown>).playerId as string).trim()
        : "";

    const result = await roomStore.roomAnswerSuggestions(
      params.roomCode,
      playerId.length > 0 ? playerId : undefined,
    );

    if (result.status === "room_not_found") {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }
    if (result.status === "player_not_found") {
      set.status = 404;
      return { ok: false, error: "PLAYER_NOT_FOUND" };
    }

    return {
      ok: true as const,
      roomCode: params.roomCode,
      suggestions: result.suggestions,
    };
  })
  .get("/results/:roomCode", async ({ params, set }) => {
    const results = roomStore.roomResults(params.roomCode);
    if (!results) {
      set.status = 404;
      return { ok: false, error: "ROOM_NOT_FOUND" };
    }

    if (results.state === "results") {
      await matchRepository.recordMatch({
        roomCode: results.roomCode,
        categoryQuery: results.categoryQuery,
        ranking: results.ranking,
      });
    }

    return results;
  });
