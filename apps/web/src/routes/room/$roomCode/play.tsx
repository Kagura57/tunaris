import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import Select, { type InputActionMeta, type SingleValue } from "react-select";
import { toRomaji } from "wanakana";
import {
  getRoomAnswerSuggestions,
  HttpStatusError,
  kickPlayer,
  leaveRoom as leaveRoomApi,
  replayRoom,
  searchPlaylistsAcrossProviders,
  sendRoomChatMessage,
  setPlayerReady,
  setRoomPublicPlaylist,
  setRoomSourceMode,
  skipRoomRound,
  startRoom,
  submitRoomAnswer,
  submitRoomAnswerDraft,
  type UnifiedPlaylistOption,
} from "../../../lib/api";
import { fetchLiveRoomState } from "../../../lib/realtime";
import { useGameStore } from "../../../stores/gameStore";

const ROUND_MS = 12_000;
const COUNTDOWN_MS = 3_000;
const REVEAL_MS = 4_000;
const LEADERBOARD_MS = 3_000;

type SourceMode = "public_playlist" | "players_liked";
type AnswerSelectOption = {
  value: string;
  label: string;
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function phaseProgress(phase: string | undefined, remainingMs: number | null) {
  if (remainingMs === null) return 0;
  if (phase === "countdown") return clamp01((COUNTDOWN_MS - remainingMs) / COUNTDOWN_MS);
  if (phase === "playing") return clamp01((ROUND_MS - remainingMs) / ROUND_MS);
  if (phase === "reveal") return clamp01((REVEAL_MS - remainingMs) / REVEAL_MS);
  if (phase === "leaderboard") return clamp01((LEADERBOARD_MS - remainingMs) / LEADERBOARD_MS);
  return 0;
}

const WAVE_BARS = Array.from({ length: 48 }, (_, index) => ({
  key: index,
  heightPercent: 22 + ((index * 17) % 70),
  delaySec: (index % 8) * 0.08,
}));

function stripProviderMentions(value: string | null | undefined) {
  if (!value) return "";
  return value
    .replace(/\bspotify\b/gi, "")
    .replace(/\bdeezer\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function playlistSecondaryLabel(playlist: UnifiedPlaylistOption) {
  const description = stripProviderMentions(playlist.description);
  if (description.length > 0) return description;
  const owner = stripProviderMentions(playlist.owner);
  if (owner.length > 0) return owner;
  return "Playlist musicale";
}

function playlistDisplayName(name: string) {
  const sanitized = stripProviderMentions(name);
  return sanitized.length > 0 ? sanitized : name;
}

function formatTrackCountLabel(value: number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return `${Math.floor(value)} titres`;
  }
  return "Nombre de titres indisponible";
}

function withRomajiLabel(value: string, providedRomaji?: string | null) {
  if (!value) return value;
  const romaji = providedRomaji?.trim().length ? providedRomaji.trim() : toRomaji(value).trim();
  if (!romaji || romaji.toLowerCase() === value.toLowerCase()) return value;
  return romaji;
}

function revealArtworkUrl(reveal: {
  provider: UnifiedPlaylistOption["provider"] | "spotify" | "youtube" | "apple-music" | "tidal";
  trackId: string;
}) {
  if (reveal.provider === "youtube") {
    return `https://i.ytimg.com/vi/${reveal.trackId}/hqdefault.jpg`;
  }
  return null;
}

function lobbyReadyStatusLabel(
  state: {
    allReady: boolean;
    canStart: boolean;
    isResolvingTracks: boolean;
    poolBuild: {
      status: "idle" | "building" | "ready" | "failed";
    };
    sourceMode: "public_playlist" | "players_liked";
    sourceConfig: {
      publicPlaylist: {
        sourceQuery: string;
      } | null;
    };
  } | null | undefined,
  isHost: boolean,
  hasActivePlayerSeat: boolean,
) {
  if (!state?.allReady) return "";
  if (!hasActivePlayerSeat) return " · Ta session joueur n'est plus active. Rejoins la room.";
  if (state.isResolvingTracks) return " · Préparation audio en cours...";
  if (!state.canStart) {
    if (state.sourceMode === "public_playlist" && !state.sourceConfig.publicPlaylist?.sourceQuery) {
      return isHost
        ? " · Choisis une playlist pour lancer."
        : " · En attente de la playlist du host.";
    }
    if (state.sourceMode === "players_liked") {
      return isHost
        ? " · Active un compte lié ou une bibliothèque déjà synchronisée pour lancer."
        : " · En attente de la configuration du host.";
    }
    return "";
  }
  if (state.sourceMode === "players_liked" && state.poolBuild.status !== "ready") {
    return " · Préparation de la playlist des joueurs en cours...";
  }
  return isHost ? " · Lancement auto en cours..." : " · En attente du host pour lancer.";
}

function isUnifiedPlaylistOption(value: unknown): value is UnifiedPlaylistOption {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UnifiedPlaylistOption>;
  const providerOk = candidate.provider === "deezer";
  return (
    providerOk &&
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.sourceQuery === "string"
  );
}

function rankAnswerSuggestions(values: string[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length <= 0) return values;

  const startsWith: string[] = [];
  const includes: string[] = [];

  for (const value of values) {
    const normalized = value.toLowerCase();
    if (normalized.startsWith(normalizedQuery)) {
      startsWith.push(value);
      continue;
    }
    if (normalized.includes(normalizedQuery)) {
      includes.push(value);
    }
  }

  if (startsWith.length <= 0 && includes.length <= 0) {
    return values.slice(0, 8);
  }
  return [...startsWith, ...includes];
}

export function RoomPlayPage() {
  const { roomCode } = useParams({ from: "/room/$roomCode/play" });
  const navigate = useNavigate();
  const session = useGameStore((state) => state.session);
  const clearSession = useGameStore((state) => state.clearSession);
  const setLiveRound = useGameStore((state) => state.setLiveRound);
  const [answer, setAnswer] = useState("");
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0);
  const [progress, setProgress] = useState(0);
  const [audioError, setAudioError] = useState(false);
  const [iframeEpoch, setIframeEpoch] = useState(0);
  const [stableYoutubePlayback, setStableYoutubePlayback] = useState<{
    key: string;
    embedUrl: string;
  } | null>(null);
  const [submittedMcq, setSubmittedMcq] = useState<{ round: number; choice: string } | null>(null);
  const [submittedText, setSubmittedText] = useState<{ round: number; value: string } | null>(null);
  const [answerSuggestionPool, setAnswerSuggestionPool] = useState<string[]>([]);
  const [sourceMode, setSourceMode] = useState<SourceMode>("public_playlist");
  const [playlistQuery, setPlaylistQuery] = useState("top hits");
  const [debouncedPlaylistQuery, setDebouncedPlaylistQuery] = useState("top hits");
  const [playlistOffset, setPlaylistOffset] = useState(0);
  const [playlistOptions, setPlaylistOptions] = useState<UnifiedPlaylistOption[]>([]);
  const [hasMorePlaylists, setHasMorePlaylists] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [spotifyRateLimitUntilMs, setSpotifyRateLimitUntilMs] = useState<number | null>(null);
  const [startRetryNotBeforeMs, setStartRetryNotBeforeMs] = useState<number | null>(null);
  const youtubeIframeRef = useRef<HTMLIFrameElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastPreviewRef = useRef<string | null>(null);
  const autoStartRoundRef = useRef<number>(0);
  const leaveSentRef = useRef(false);
  const progressStateRef = useRef<{ key: string; value: number }>({ key: "", value: 0 });
  const postRoundProgressRef = useRef<{ key: string; startedAtMs: number } | null>(null);
  const audioRetryTimeoutRef = useRef<number | null>(null);
  const autoSubmitSignatureRef = useRef<string | null>(null);
  const draftSignatureRef = useRef<string | null>(null);
  const userInteractionUnlockedRef = useRef(false);
  const roomMissingRedirectedRef = useRef(false);
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setClockNow(Date.now() + serverClockOffsetMs), 80);
    return () => window.clearInterval(id);
  }, [serverClockOffsetMs]);

  const snapshotQuery = useQuery({
    queryKey: ["realtime-room", roomCode],
    queryFn: async () => {
      const snapshot = await fetchLiveRoomState(roomCode);
      return {
        ok: true as const,
        roomCode,
        snapshot,
        serverNowMs: snapshot.serverNowMs,
      };
    },
    refetchInterval: 1_000,
  });

  const state = snapshotQuery.data?.snapshot;
  useEffect(() => {
    if (typeof snapshotQuery.data?.serverNowMs !== "number") return;
    setServerClockOffsetMs(snapshotQuery.data.serverNowMs - Date.now());
  }, [snapshotQuery.data?.serverNowMs]);

  useEffect(() => {
    if (roomMissingRedirectedRef.current) return;
    const error = snapshotQuery.error;
    if (!(error instanceof HttpStatusError)) return;
    if (error.status !== 404 || error.message !== "ROOM_NOT_FOUND") return;
    roomMissingRedirectedRef.current = true;
    clearSession();
    navigate({ to: "/" });
  }, [clearSession, navigate, snapshotQuery.error]);

  const isHost = Boolean(session.playerId && state?.hostPlayerId === session.playerId);
  const isWaitingLobby = state?.state === "waiting";
  const isResolvingTracks = Boolean(state?.isResolvingTracks);
  const isPlayersLikedPoolBuilding =
    state?.sourceMode === "players_liked" && state.poolBuild.status === "building";
  const currentPlayer = state?.players.find((player) => player.playerId === session.playerId) ?? null;
  const hasActivePlayerSeat = Boolean(currentPlayer);
  const lobbyReadyStatus = lobbyReadyStatusLabel(state, isHost, hasActivePlayerSeat);
  const typedPlaylistQuery = playlistQuery.trim();
  const normalizedPlaylistQuery = debouncedPlaylistQuery.trim();
  const typedAnswer = answer.trim();
  const chatMessages = useMemo(() => {
    const messages = [...(state?.chatMessages ?? [])];
    messages.sort((left, right) => left.sentAtMs - right.sentAtMs);
    return messages;
  }, [state?.chatMessages]);

  useEffect(() => {
    if (!state?.sourceMode) return;
    setSourceMode(state.sourceMode);
  }, [state?.sourceMode]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedPlaylistQuery(playlistQuery);
    }, 320);
    return () => window.clearTimeout(timeoutId);
  }, [playlistQuery]);

  useEffect(() => {
    setPlaylistOffset(0);
  }, [normalizedPlaylistQuery, sourceMode, roomCode]);

  const playlistSearchQuery = useQuery({
    queryKey: ["lobby-playlist-search", normalizedPlaylistQuery, playlistOffset],
    queryFn: async () => {
      const payload = (await searchPlaylistsAcrossProviders({
        q: normalizedPlaylistQuery,
        limit: 24,
        offset: playlistOffset,
      })) as {
        ok: boolean;
        q: string;
        hasMore: boolean;
        nextOffset: number | null;
        playlists: unknown;
      };
      const rawPlaylists = Array.isArray(payload.playlists) ? payload.playlists : [];
      const playlists = rawPlaylists.filter(isUnifiedPlaylistOption);
      return {
        ok: payload.ok,
        q: payload.q,
        hasMore: payload.hasMore,
        nextOffset: payload.nextOffset,
        playlists,
      };
    },
    enabled: isWaitingLobby && isHost && sourceMode === "public_playlist" && normalizedPlaylistQuery.length >= 2,
    staleTime: 2 * 60_000,
  });

  const bulkAnswerSuggestionsQuery = useQuery({
    queryKey: ["room-answer-suggestions", roomCode, state?.sourceMode ?? "unknown", session.playerId ?? "anonymous"],
    queryFn: () =>
      getRoomAnswerSuggestions({
        roomCode,
        playerId: session.playerId,
      }),
    enabled: Boolean(session.playerId),
    staleTime: 10 * 60_000,
    retry: 1,
  });

  const maxSuggestionPoolSize = 24_000;

  useEffect(() => {
    setAnswerSuggestionPool([]);
  }, [roomCode]);

  useEffect(() => {
    const incomingSuggestions = state?.answerSuggestions ?? [];
    if (incomingSuggestions.length <= 0) return;

    setAnswerSuggestionPool((previous) => {
      const merged = [...previous];
      const seen = new Set(merged.map((value) => value.toLowerCase()));

      for (const value of incomingSuggestions) {
        const normalized = value.trim();
        if (normalized.length < 2) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(normalized);
      }

      if (merged.length <= maxSuggestionPoolSize) return merged;
      return merged.slice(-maxSuggestionPoolSize);
    });
  }, [state?.answerSuggestions]);

  useEffect(() => {
    const incomingSuggestions = bulkAnswerSuggestionsQuery.data?.suggestions ?? [];
    if (incomingSuggestions.length <= 0) return;

    setAnswerSuggestionPool((previous) => {
      const merged = [...previous];
      const seen = new Set(merged.map((value) => value.toLowerCase()));

      for (const value of incomingSuggestions) {
        const normalized = value.trim();
        if (normalized.length < 2) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(normalized);
      }

      if (merged.length <= maxSuggestionPoolSize) return merged;
      return merged.slice(-maxSuggestionPoolSize);
    });
  }, [bulkAnswerSuggestionsQuery.data?.suggestions]);

  const answerSelectOptions = useMemo<AnswerSelectOption[]>(() => {
    if (typedAnswer.length < 3) return [];
    const rankedPool = rankAnswerSuggestions(answerSuggestionPool, typedAnswer);
    const values = rankedPool;
    const deduped: AnswerSelectOption[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const normalized = value.trim();
      if (normalized.length <= 0) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({ value: normalized, label: normalized });
    }
    return deduped;
  }, [answerSuggestionPool, typedAnswer]);
  const selectedAnswerOption = useMemo<AnswerSelectOption | null>(() => {
    const normalized = answer.trim();
    if (normalized.length <= 0) return null;
    const existing =
      answerSelectOptions.find((option) => option.value.toLowerCase() === normalized.toLowerCase()) ?? null;
    if (existing) return existing;
    return { value: normalized, label: normalized };
  }, [answer, answerSelectOptions]);
  const answerSeedIsLoading =
    state?.state === "playing" &&
    state.mode === "text" &&
    (isResolvingTracks || bulkAnswerSuggestionsQuery.isFetching) &&
    answerSuggestionPool.length <= 0;

  const showRevealAnswersInLeaderboard = state?.state === "reveal" || state?.state === "leaderboard";
  const revealAnswerByPlayerId = useMemo(() => {
    const map = new Map<
      string,
      { answer: string | null; submitted: boolean; isCorrect: boolean }
    >();
    if (!showRevealAnswersInLeaderboard || !state?.reveal) return map;
    for (const entry of state.reveal.playerAnswers) {
      map.set(entry.playerId, {
        answer: entry.answer,
        submitted: entry.submitted,
        isCorrect: entry.isCorrect,
      });
    }
    return map;
  }, [showRevealAnswersInLeaderboard, state?.reveal]);

  useEffect(() => {
    if (!playlistSearchQuery.data) return;
    setHasMorePlaylists(Boolean(playlistSearchQuery.data.hasMore));
    setPlaylistOptions((previous) => {
      if (playlistOffset <= 0) return playlistSearchQuery.data?.playlists ?? [];
      const merged = [...previous];
      const seen = new Set(merged.map((item) => `${item.provider}:${item.id}`));
      for (const playlist of playlistSearchQuery.data.playlists ?? []) {
        const key = `${playlist.provider}:${playlist.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(playlist);
      }
      return merged;
    });
  }, [playlistOffset, playlistSearchQuery.data]);
  useEffect(() => {
    if (!state) {
      setLiveRound(null);
      return;
    }

    setLiveRound({
      phase: state.state,
      mode: state.mode,
      round: state.round,
      totalRounds: state.totalRounds,
      deadlineMs: state.deadlineMs,
      previewUrl: state.previewUrl,
      media: state.media,
      choices: state.choices,
      reveal: state.reveal
        ? {
            trackId: state.reveal.trackId,
            provider: state.reveal.provider,
            title: state.reveal.title,
            artist: state.reveal.artist,
            acceptedAnswer: state.reveal.acceptedAnswer,
            previewUrl: state.reveal.previewUrl,
            sourceUrl: state.reveal.sourceUrl,
            embedUrl: state.reveal.embedUrl,
            playerAnswers: state.reveal.playerAnswers,
          }
        : null,
      leaderboard: state.leaderboard,
    });
  }, [setLiveRound, state]);

  const startMutation = useMutation({
    mutationFn: () => {
      if (!session.playerId) throw new Error("PLAYER_NOT_FOUND");
      return startRoom({
        roomCode,
        playerId: session.playerId,
      });
    },
    onSuccess: (result) => {
      if (result.ok === false) {
        const retryAfterMs =
          typeof result.retryAfterMs === "number" && result.retryAfterMs > 0 ? result.retryAfterMs : 1_500;
        autoStartRoundRef.current = 0;
        setStartRetryNotBeforeMs(Date.now() + retryAfterMs);
        setSpotifyRateLimitUntilMs(null);
        snapshotQuery.refetch();
        return;
      }
      setStartRetryNotBeforeMs(null);
      setSpotifyRateLimitUntilMs(null);
      snapshotQuery.refetch();
    },
    onError: (error) => {
      if (error instanceof HttpStatusError && error.message === "SPOTIFY_RATE_LIMITED") {
        const retryAfterMs = error.retryAfterMs && error.retryAfterMs > 0 ? error.retryAfterMs : 10_000;
        setSpotifyRateLimitUntilMs(Date.now() + retryAfterMs);
        setStartRetryNotBeforeMs(null);
        return;
      }
      if (
        error instanceof HttpStatusError &&
        (error.message === "PLAYERS_LIBRARY_SYNCING" || error.message === "PLAYLIST_TRACKS_RESOLVING")
      ) {
        const retryAfterMs = error.retryAfterMs && error.retryAfterMs > 0 ? error.retryAfterMs : 1_500;
        // Keep auto-start active while tracks are still being resolved.
        autoStartRoundRef.current = 0;
        setStartRetryNotBeforeMs(Date.now() + retryAfterMs);
        setSpotifyRateLimitUntilMs(null);
        snapshotQuery.refetch();
        return;
      }
      setStartRetryNotBeforeMs(null);
      setSpotifyRateLimitUntilMs(null);
    },
  });

  const startRetryRemainingMs = useMemo(() => {
    if (!startRetryNotBeforeMs) return 0;
    return Math.max(0, startRetryNotBeforeMs - clockNow);
  }, [clockNow, startRetryNotBeforeMs]);

  useEffect(() => {
    if (!state || !isHost || state.state !== "waiting") {
      autoStartRoundRef.current = 0;
      return;
    }
    if (
      !state.allReady ||
      !state.canStart ||
      startMutation.isPending ||
      startRetryRemainingMs > 0 ||
      isResolvingTracks ||
      isPlayersLikedPoolBuilding
    ) {
      return;
    }
    const signature = state.readyCount * 1000 + state.players.length;
    if (autoStartRoundRef.current === signature) return;
    autoStartRoundRef.current = signature;
    startMutation.mutate();
  }, [
    isHost,
    isResolvingTracks,
    isPlayersLikedPoolBuilding,
    startRetryRemainingMs,
    startMutation,
    startMutation.isPending,
    state,
  ]);

  const sourceModeMutation = useMutation({
    mutationFn: (mode: SourceMode) => {
      if (!session.playerId) throw new Error("PLAYER_NOT_FOUND");
      return setRoomSourceMode({
        roomCode,
        playerId: session.playerId,
        mode,
      });
    },
    onSuccess: () => snapshotQuery.refetch(),
  });

  const publicPlaylistMutation = useMutation({
    mutationFn: (playlist: UnifiedPlaylistOption) => {
      if (!session.playerId) throw new Error("PLAYER_NOT_FOUND");
      return setRoomPublicPlaylist({
        roomCode,
        playerId: session.playerId,
        id: playlist.id,
        name: playlist.name,
        trackCount: playlist.trackCount,
        sourceQuery: playlist.sourceQuery,
      });
    },
    onSuccess: () => snapshotQuery.refetch(),
  });

  const readyMutation = useMutation({
    mutationFn: (ready: boolean) => {
      if (!session.playerId) throw new Error("PLAYER_NOT_FOUND");
      return setPlayerReady({
        roomCode,
        playerId: session.playerId,
        ready,
      });
    },
    onSuccess: () => snapshotQuery.refetch(),
  });

  const kickMutation = useMutation({
    mutationFn: (targetPlayerId: string) => {
      if (!session.playerId) throw new Error("PLAYER_NOT_FOUND");
      return kickPlayer({
        roomCode,
        playerId: session.playerId,
        targetPlayerId,
      });
    },
    onSuccess: () => snapshotQuery.refetch(),
  });

  const replayMutation = useMutation({
    mutationFn: () => {
      if (!session.playerId) throw new Error("PLAYER_NOT_FOUND");
      return replayRoom({
        roomCode,
        playerId: session.playerId,
      });
    },
    onSuccess: () => snapshotQuery.refetch(),
  });

  const skipMutation = useMutation({
    mutationFn: () => {
      if (!session.playerId) throw new Error("PLAYER_NOT_FOUND");
      return skipRoomRound({
        roomCode,
        playerId: session.playerId,
      });
    },
    onSuccess: () => snapshotQuery.refetch(),
  });

  const answerMutation = useMutation({
    mutationFn: (value: string) =>
      submitRoomAnswer({
        roomCode,
        playerId: session.playerId ?? "",
        answer: value,
      }),
    onSuccess: () => snapshotQuery.refetch(),
  });

  const answerDraftMutation = useMutation({
    mutationFn: (value: string) =>
      submitRoomAnswerDraft({
        roomCode,
        playerId: session.playerId ?? "",
        answer: value,
      }),
  });

  const chatMutation = useMutation({
    mutationFn: async (text: string) => {
      if (!session.playerId) throw new Error("PLAYER_NOT_FOUND");
      return sendRoomChatMessage({
        roomCode,
        playerId: session.playerId,
        text,
      });
    },
    onSuccess: () => {
      setChatInput("");
      snapshotQuery.refetch();
    },
    onError: (error) => {
      if (!(error instanceof HttpStatusError)) return;
      if (error.status !== 404 || error.message !== "ROOM_NOT_FOUND") return;
      if (roomMissingRedirectedRef.current) return;
      roomMissingRedirectedRef.current = true;
      clearSession();
      navigate({ to: "/" });
    },
  });

  const startErrorCode = startMutation.error instanceof Error ? startMutation.error.message : null;
  const isNonBlockingStartError =
    startErrorCode === "PLAYERS_LIBRARY_SYNCING" || startErrorCode === "PLAYLIST_TRACKS_RESOLVING";
  const sourceModeErrorCode = sourceModeMutation.error instanceof Error ? sourceModeMutation.error.message : null;
  const publicPlaylistErrorCode =
    publicPlaylistMutation.error instanceof Error ? publicPlaylistMutation.error.message : null;
  const readyErrorCode = readyMutation.error instanceof Error ? readyMutation.error.message : null;
  const kickErrorCode = kickMutation.error instanceof Error ? kickMutation.error.message : null;
  const replayErrorCode = replayMutation.error instanceof Error ? replayMutation.error.message : null;
  const skipErrorCode = skipMutation.error instanceof Error ? skipMutation.error.message : null;
  const spotifyCooldownRemainingMs = useMemo(() => {
    if (!spotifyRateLimitUntilMs) return 0;
    return Math.max(0, spotifyRateLimitUntilMs - clockNow);
  }, [clockNow, spotifyRateLimitUntilMs]);
  const spotifyCooldownRemainingSec = Math.max(1, Math.ceil(spotifyCooldownRemainingMs / 1000));

  useEffect(() => {
    if (!isNonBlockingStartError) return;
    startMutation.reset();
  }, [isNonBlockingStartError, startMutation]);

  const remainingMs = useMemo(() => {
    if (!state?.deadlineMs) return null;
    return state.deadlineMs - clockNow;
  }, [clockNow, state?.deadlineMs]);
  const roundMediaKey = `${state?.round ?? 0}:${state?.media?.trackId ?? state?.reveal?.trackId ?? "none"}`;
  const progressKey = `${state?.state ?? "none"}:${state?.round ?? 0}:${state?.deadlineMs ?? 0}:${state?.media?.trackId ?? state?.reveal?.trackId ?? "none"}`;

  useEffect(() => {
    if (!state) {
      progressStateRef.current = { key: "", value: 0 };
      postRoundProgressRef.current = null;
      setProgress(0);
      return;
    }

    if (state.state === "reveal" || state.state === "leaderboard") {
      const postKey = `post-round:${roundMediaKey}`;
      if (!postRoundProgressRef.current || postRoundProgressRef.current.key !== postKey) {
        postRoundProgressRef.current = { key: postKey, startedAtMs: clockNow };
      }
      const startedAtMs = postRoundProgressRef.current.startedAtMs;
      const elapsedMs = Math.max(0, clockNow - startedAtMs);
      const rawProgress = clamp01(elapsedMs / (REVEAL_MS + LEADERBOARD_MS));
      const previous = progressStateRef.current;
      const nextProgress =
        previous.key === postKey ? Math.max(previous.value, rawProgress) : rawProgress;

      progressStateRef.current = {
        key: postKey,
        value: nextProgress,
      };
      setProgress(nextProgress);
      return;
    }

    postRoundProgressRef.current = null;
    const rawProgress = phaseProgress(state.state, remainingMs);
    const previous = progressStateRef.current;
    const nextProgress =
      previous.key === progressKey ? Math.max(previous.value, rawProgress) : rawProgress;

    progressStateRef.current = {
      key: progressKey,
      value: nextProgress,
    };
    setProgress(nextProgress);
  }, [progressKey, remainingMs, state]);

  const youtubePlayback = useMemo(() => {
    if (!state?.media?.embedUrl || !state.media.trackId) return null;
    if (state.media.provider !== "youtube") return null;
    return {
      key: `${state.media.provider}:${state.media.trackId}`,
      embedUrl: state.media.embedUrl,
    };
  }, [state?.media?.embedUrl, state?.media?.provider, state?.media?.trackId]);

  useEffect(() => {
    if (youtubePlayback) {
      setStableYoutubePlayback((previous) => {
        if (previous?.key === youtubePlayback.key) return previous;
        return youtubePlayback;
      });
      return;
    }

    const shouldClear =
      state?.state === "waiting" ||
      state?.state === "playing" ||
      state?.state === "results" ||
      state?.state === undefined;
    if (shouldClear) {
      setStableYoutubePlayback(null);
    }
  }, [state?.state, youtubePlayback]);

  const activeYoutubeEmbed = stableYoutubePlayback?.embedUrl ?? null;
  const usingYouTubePlayback = Boolean(activeYoutubeEmbed);
  const revealVideoActive =
    usingYouTubePlayback &&
    state?.state !== "waiting" &&
    state?.state !== "playing" &&
    state?.state !== "results";
  const isResults = state?.state === "results";
  const mcqLocked =
    state?.state === "playing" &&
    state.mode === "mcq" &&
    submittedMcq !== null &&
    submittedMcq.round === state.round;
  const textLocked =
    state?.state === "playing" &&
    state.mode === "text" &&
    submittedText !== null &&
    submittedText.round === state.round;
  const roundLabel = `${state?.round ?? 0}/${state?.totalRounds ?? 0}`;
  const revealArtwork = state?.reveal ? revealArtworkUrl(state.reveal) : null;

  useEffect(() => {
    const iframe = youtubeIframeRef.current;
    if (!iframe || !activeYoutubeEmbed) return;
    const iframeWindow = iframe.contentWindow;
    if (!iframeWindow) return;
    const iframeId = `kwizik-youtube-${stableYoutubePlayback?.key ?? "unknown"}`;
    iframe.id = iframeId;

    const subscribe = () => {
      const baseEvent = { id: iframeId, channel: "widget" };
      iframeWindow.postMessage(JSON.stringify({ event: "listening", ...baseEvent }), "*");
      iframeWindow.postMessage(
        JSON.stringify({
          event: "command",
          func: "addEventListener",
          args: ["onError"],
          ...baseEvent,
        }),
        "*",
      );
    };
    subscribe();
    const subscribeInterval = window.setInterval(subscribe, 1_000);

    function onMessage(event: MessageEvent) {
      if (event.source !== iframeWindow) return;
      if (typeof event.origin !== "string" || !event.origin.includes("youtube.com")) return;
      if (typeof event.data !== "string") return;

      try {
        const payload = JSON.parse(event.data) as { event?: string; info?: unknown };
        if (payload.event !== "onError") return;
        const code = Number(payload.info);
        if (![2, 5, 100, 101, 150].includes(code)) return;
        setAudioError(true);
      } catch {
        // Ignore non-JSON postMessage payloads.
      }
    }

    window.addEventListener("message", onMessage);
    return () => {
      window.clearInterval(subscribeInterval);
      window.removeEventListener("message", onMessage);
    };
  }, [activeYoutubeEmbed, stableYoutubePlayback?.key]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audioRetryTimeoutRef.current !== null) {
      window.clearTimeout(audioRetryTimeoutRef.current);
      audioRetryTimeoutRef.current = null;
    }

    if (activeYoutubeEmbed) {
      audio.pause();
      audio.removeAttribute("src");
      lastPreviewRef.current = null;
      return;
    }

    const previewUrl = state?.previewUrl ?? null;
    if (!previewUrl) {
      audio.pause();
      lastPreviewRef.current = null;
      return;
    }

    setAudioError(false);
    if (lastPreviewRef.current !== previewUrl) {
      lastPreviewRef.current = previewUrl;
      audio.src = previewUrl;
      audio.currentTime = 0;
    }

    const playPromise = audio.play();
    if (playPromise) {
      playPromise.catch(() => {
        if (audioRetryTimeoutRef.current !== null) return;
        audioRetryTimeoutRef.current = window.setTimeout(() => {
          audioRetryTimeoutRef.current = null;
          const nextAudio = audioRef.current;
          if (!nextAudio || !nextAudio.src) return;
          nextAudio.play().catch(() => undefined);
        }, 320);
      });
    }
  }, [activeYoutubeEmbed, state?.previewUrl, state?.state]);

  useEffect(() => {
    function unlockAudioPlayback() {
      const shouldKickIframe = Boolean(activeYoutubeEmbed) && !userInteractionUnlockedRef.current;
      userInteractionUnlockedRef.current = true;

      const audio = audioRef.current;
      if (audio && audio.src) {
        audio.play().catch(() => undefined);
      }
      if (shouldKickIframe) {
        setIframeEpoch((value) => value + 1);
      }
    }

    window.addEventListener("pointerdown", unlockAudioPlayback, { passive: true });
    window.addEventListener("keydown", unlockAudioPlayback);

    return () => {
      window.removeEventListener("pointerdown", unlockAudioPlayback);
      window.removeEventListener("keydown", unlockAudioPlayback);
    };
  }, [activeYoutubeEmbed]);

  useEffect(() => {
    return () => {
      if (audioRetryTimeoutRef.current !== null) {
        window.clearTimeout(audioRetryTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    if (state.state !== "playing") {
      setSubmittedMcq(null);
      setSubmittedText(null);
      return;
    }

    if (state.mode === "mcq" && submittedMcq && submittedMcq.round !== state.round) {
      setSubmittedMcq(null);
    }
    if (state.mode === "text" && submittedText && submittedText.round !== state.round) {
      setSubmittedText(null);
      setAnswer("");
    }
  }, [state, submittedMcq, submittedText]);

  useEffect(() => {
    if (!state || state.round <= 0) return;
    setAnswer("");
  }, [state?.round]);

  useEffect(() => {
    if (!state || state.state !== "playing" || state.mode !== "text" || !session.playerId || textLocked) {
      draftSignatureRef.current = null;
      return;
    }

    const value = answer.trim().slice(0, 80);
    const signature = `${state.round}:${value}`;
    if (draftSignatureRef.current === signature) return;
    draftSignatureRef.current = signature;

    const timeoutId = window.setTimeout(() => {
      answerDraftMutation.mutate(value);
    }, 90);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [answer, answerDraftMutation, session.playerId, state, textLocked]);

  useEffect(() => {
    if (!state || state.state !== "playing" || state.mode !== "text") {
      autoSubmitSignatureRef.current = null;
      return;
    }
    if (!session.playerId || textLocked || answerMutation.isPending || !state.deadlineMs) return;

    const value = answer.trim();
    if (!value) return;

    const remainingMs = state.deadlineMs - clockNow;
    if (remainingMs > 220 || remainingMs < -700) return;

    const signature = `${state.round}:${value.toLowerCase()}`;
    if (autoSubmitSignatureRef.current === signature) return;
    autoSubmitSignatureRef.current = signature;

    setSubmittedText({ round: state.round, value });
    answerMutation.mutate(value);
  }, [
    answer,
    answerMutation,
    clockNow,
    session.playerId,
    state,
    textLocked,
  ]);

  function onSubmitText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state || state.state !== "playing" || state.mode !== "text") return;
    if (textLocked) return;

    const value = answer.trim();
    if (!value || !session.playerId) return;
    autoSubmitSignatureRef.current = `${state.round}:${value.toLowerCase()}`;
    setSubmittedText({ round: state.round, value });
    answerMutation.mutate(value);
  }

  function onSelectChoice(choice: string) {
    if (!state || state.state !== "playing" || state.mode !== "mcq") return;
    if (!session.playerId || mcqLocked) return;
    setSubmittedMcq({ round: state.round, choice });
    answerMutation.mutate(choice);
  }

  function onSubmitChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session.playerId) return;
    const value = chatInput.trim();
    if (value.length <= 0) return;
    chatMutation.mutate(value);
  }

  useEffect(() => {
    if (!chatLogRef.current || !chatEndRef.current) return;
    chatEndRef.current.scrollIntoView({ block: "end", behavior: "auto" });
  }, [chatMessages.length]);

  function onSelectSourceMode(mode: SourceMode) {
    setSourceMode(mode);
    sourceModeMutation.mutate(mode);
  }

  function dispatchLeaveSignal() {
    if (leaveSentRef.current || !session.playerId) return;
    leaveSentRef.current = true;

    const payload = JSON.stringify({
      roomCode,
      playerId: session.playerId,
    });

    const envBase = import.meta.env.VITE_API_BASE_URL?.trim() ?? "";
    const baseUrl = envBase.length > 0
      ? envBase.replace(/\/+$/, "")
      : `${window.location.origin}/api`;
    const target = `${baseUrl}/quiz/leave`;

    try {
      const blob = new Blob([payload], { type: "application/json" });
      const sent = navigator.sendBeacon(target, blob);
      if (sent) return;
    } catch {
      // Fall through to fetch keepalive fallback.
    }

    fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
      credentials: "include",
    }).catch(() => undefined);
  }

  useEffect(() => {
    if (!session.playerId) return;
    leaveSentRef.current = false;
    const shouldDispatchOnCleanup = !import.meta.env.DEV;

    function onPageHide() {
      dispatchLeaveSignal();
    }
    function onBeforeUnload() {
      dispatchLeaveSignal();
    }

    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (shouldDispatchOnCleanup) {
        dispatchLeaveSignal();
      }
    };
  }, [roomCode, session.playerId]);

  async function leaveRoom() {
    if (session.playerId) {
      leaveSentRef.current = true;
    }
    if (session.playerId) {
      try {
        await leaveRoomApi({ roomCode, playerId: session.playerId });
      } catch {
        dispatchLeaveSignal();
      }
    }
    clearSession();
    navigate({ to: "/" });
  }

  const topThree = (state?.leaderboard ?? []).slice(0, 3);
  const podiumByRank = new Map(topThree.map((entry) => [entry.rank, entry]));
  const podiumSlots = [
    { rank: 2, tone: "silver" as const, entry: podiumByRank.get(2) ?? null },
    { rank: 1, tone: "gold" as const, entry: podiumByRank.get(1) ?? null },
    { rank: 3, tone: "bronze" as const, entry: podiumByRank.get(3) ?? null },
  ];

  return (
    <section className="blindtest-stage">
      <article className={`stage-main arena-layout${isResults ? " results-fullscreen" : ""}`}>
        {!isResults && (
          <aside className="arena-side leaderboard-side">
            <h2 className="side-title">Classement live</h2>
            {state?.leaderboard && state.leaderboard.length > 0 ? (
              <ol className="leaderboard-list compact">
                {state.leaderboard.map((entry) => (
                  <li key={entry.playerId} className={entry.hasAnsweredCurrentRound ? "answered" : ""}>
                    <span>#{entry.rank}</span>
                    <div className="leaderboard-player-block">
                      <strong className="leaderboard-name">
                        {entry.displayName}
                        {entry.hasAnsweredCurrentRound && (
                          <i className="answer-check" aria-label="Reponse validee">
                            ✓
                          </i>
                        )}
                      </strong>
                      {showRevealAnswersInLeaderboard && (() => {
                        const revealAnswer = revealAnswerByPlayerId.get(entry.playerId);
                        if (!revealAnswer) return null;
                        const label = revealAnswer.submitted && revealAnswer.answer
                          ? withRomajiLabel(revealAnswer.answer)
                          : "Pas de réponse";
                        return (
                          <small
                            className={`leaderboard-reveal-answer${revealAnswer.isCorrect ? " correct" : revealAnswer.submitted ? " wrong" : ""}`}
                          >
                            {label}
                          </small>
                        );
                      })()}
                    </div>
                    <div className="leaderboard-score-block">
                      <em>{entry.score} pts</em>
                      <small className="leaderboard-meta">
                        <span className="round-gain">+{entry.lastRoundScore}</span>
                        <span className={`streak-chip${entry.streak > 0 ? " hot" : ""}`}>
                          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path d="M12 2c.5 3-2 4.8-2 7.2 0 1.5 1 2.7 2 3.4 1.1-.7 2-2 2-3.6 0-1.8-1-3.1-2-4.6 2 .8 4.8 3.4 4.8 7.1A4.8 4.8 0 0 1 12 20a4.8 4.8 0 0 1-4.8-4.9C7.2 10.6 10.1 7.8 12 2Z" />
                          </svg>
                          {entry.streak}
                        </span>
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="status">Le classement s’affiche dès que des joueurs sont présents.</p>
            )}
          </aside>
        )}

        <div className={`gameplay-center${isResults ? " results-compact" : ""}`}>
          {!isResults && (
            <>
              <div className="round-strip">
                <span>Room {roomCode}</span>
                <strong>Manche {roundLabel}</strong>
              </div>

              <div className={`sound-visual${revealVideoActive ? " reveal-active" : ""}`}>
                <div className="wave-bars" aria-hidden="true">
                  {WAVE_BARS.map((bar) => (
                    <span
                      key={bar.key}
                      style={{
                        height: `${bar.heightPercent}%`,
                        animationDelay: `${bar.delaySec}s`,
                      }}
                    />
                  ))}
                </div>
                <div className="sound-timeline">
                  <span style={{ width: `${(progress * 100).toFixed(3)}%` }} />
                </div>
              </div>
            </>
          )}

          {state?.state === "waiting" && (
            <div className="waiting-box">
              <h2>Le host peut lancer la partie quand il le souhaite.</h2>
              {(isResolvingTracks || isPlayersLikedPoolBuilding) && (
                <div className="resolving-tracks-banner" role="status" aria-live="polite">
                  <span className="resolving-tracks-spinner" aria-hidden="true" />
                  <div>
                    <strong>Résolution des sources audio en cours...</strong>
                    <p className="status">Préparation de la playlist des joueurs...</p>
                  </div>
                </div>
              )}

              {isHost ? (
                <div className="field-block">
                  <span className="field-label">Mode source (host)</span>
                  <div className="source-preset-grid">
                    <button
                      type="button"
                      className={`source-preset-btn${sourceMode === "public_playlist" ? " active" : ""}`}
                      onClick={() => onSelectSourceMode("public_playlist")}
                    >
                      <strong>Playlist publique</strong>
                      <span>Recherche publique Deezer</span>
                    </button>
                    <button
                      type="button"
                      className={`source-preset-btn${sourceMode === "players_liked" ? " active" : ""}`}
                      onClick={() => onSelectSourceMode("players_liked")}
                    >
                      <strong>Liked Songs joueurs</strong>
                      <span>Pool collaboratif des joueurs</span>
                    </button>
                  </div>

                  {sourceMode === "public_playlist" && (
                    <>
                      <div className="playlist-search-shell">
                        <p className="playlist-search-kicker">Recherche playlist Deezer</p>
                        <div className="playlist-search-input-wrap">
                          <input
                            id="playlist-search-input"
                            aria-label="Recherche playlist"
                            value={playlistQuery}
                            onChange={(event) => setPlaylistQuery(event.currentTarget.value)}
                            maxLength={120}
                            placeholder="Ex: top hits, rap 2000, anime openings"
                          />
                        </div>
                      </div>
                      {typedPlaylistQuery.length < 2 && (
                        <p className="status">Tape au moins 2 caractères pour chercher une playlist.</p>
                      )}
                      {typedPlaylistQuery.length >= 2 &&
                        typedPlaylistQuery !== normalizedPlaylistQuery && (
                          <p className="status">Recherche en cours...</p>
                        )}
                      {typedPlaylistQuery.length >= 2 &&
                        typedPlaylistQuery === normalizedPlaylistQuery &&
                        playlistSearchQuery.isPending && (
                        <p className="status">Recherche en cours...</p>
                      )}
                      {typedPlaylistQuery.length >= 2 &&
                        typedPlaylistQuery === normalizedPlaylistQuery &&
                        playlistSearchQuery.isError && (
                        <p className="status">Recherche temporairement indisponible.</p>
                      )}
                      {typedPlaylistQuery.length >= 2 &&
                        typedPlaylistQuery === normalizedPlaylistQuery &&
                        !playlistSearchQuery.isPending &&
                        !playlistSearchQuery.isError &&
                        playlistOptions.length === 0 && (
                          <p className="status">Aucun résultat pour cette recherche.</p>
                        )}
                      <div className="playlist-card-grid">
                        {playlistOptions.map((playlist) => (
                          <button
                            key={`${playlist.provider}:${playlist.id}`}
                            type="button"
                            className={`playlist-card-btn${state.sourceConfig.publicPlaylist?.sourceQuery === playlist.sourceQuery ? " active" : ""}`}
                            onClick={() => publicPlaylistMutation.mutate(playlist)}
                            disabled={publicPlaylistMutation.isPending}
                          >
                            {playlist.imageUrl ? (
                              <img src={playlist.imageUrl} alt={playlist.name} loading="lazy" />
                            ) : (
                              <div className="playlist-card-placeholder" aria-hidden="true" />
                            )}
                            <div>
                              <strong>{withRomajiLabel(playlistDisplayName(playlist.name))}</strong>
                              <p>{playlistSecondaryLabel(playlist)}</p>
                              <small>{formatTrackCountLabel(playlist.trackCount)}</small>
                            </div>
                          </button>
                        ))}
                      </div>
                      {typedPlaylistQuery.length >= 2 &&
                        !playlistSearchQuery.isPending &&
                        hasMorePlaylists && (
                          <button
                            className="ghost-btn"
                            type="button"
                            onClick={() => setPlaylistOffset((current) => current + 24)}
                            disabled={playlistSearchQuery.isFetching}
                          >
                            {playlistSearchQuery.isFetching ? "Chargement..." : "Load more"}
                          </button>
                        )}
                    </>
                  )}

                  {sourceMode === "players_liked" && (
                    <div className="panel-form">
                      <p className="status">
                        Les comptes Spotify / Deezer connectés des joueurs sont utilisés automatiquement.
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="status">Seul le host peut modifier la configuration source.</p>
              )}

              <div className="room-meta-list">
                <p>
                  <span>Mode source</span>
                  <strong>{state.sourceMode === "players_liked" ? "Liked Songs joueurs" : "Playlist publique"}</strong>
                </p>
                <p>
                  <span>Playlist</span>
                  <strong>{withRomajiLabel(state.sourceConfig.publicPlaylist?.name ?? "Aucune playlist selectionnee")}</strong>
                </p>
              </div>

              <div className="waiting-actions">
                <button
                  className={`ghost-btn${currentPlayer?.isReady ? " selected" : ""}`}
                  type="button"
                  disabled={!hasActivePlayerSeat || readyMutation.isPending || isResolvingTracks}
                  onClick={() => {
                    if (!currentPlayer) return;
                    readyMutation.mutate(!currentPlayer.isReady);
                  }}
                >
                  {currentPlayer?.isReady ? "Je ne suis plus prêt" : "Je suis prêt"}
                </button>
                {isHost && (
                  <button
                    className="solid-btn"
                    onClick={() => startMutation.mutate()}
                    disabled={
                      startMutation.isPending ||
                      startRetryRemainingMs > 0 ||
                      !state.canStart ||
                      isResolvingTracks ||
                      isPlayersLikedPoolBuilding
                    }
                  >
                    {startMutation.isPending ? "Lancement..." : "Lancer la partie"}
                  </button>
                )}
              </div>

              <p className="status">
                Joueurs prêts: {state.readyCount}/{state.players.length}
                {lobbyReadyStatus}
              </p>
              <ul className="lobby-player-list">
                {state.players.map((player) => (
                  <li key={player.playerId}>
                    <div>
                      <strong>{player.displayName}</strong>
                      <p>
                        {player.isHost ? "Host" : "Joueur"} - {player.isReady ? "Prêt" : "En attente"}
                      </p>
                    </div>
                    {isHost && player.playerId !== session.playerId && (
                      <button
                        className="ghost-btn"
                        type="button"
                        disabled={kickMutation.isPending}
                        onClick={() => kickMutation.mutate(player.playerId)}
                      >
                        Éjecter
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {state?.state === "playing" && state.mode === "mcq" && (
            <div className="mcq-grid">
              {(state.choices ?? []).map((choice, index) => (
                <button
                  key={`${choice}-${index}`}
                  className={`choice-btn${submittedMcq?.round === state.round && submittedMcq.choice === choice ? " selected" : ""}`}
                  disabled={answerMutation.isPending || !session.playerId || mcqLocked}
                  onClick={() => onSelectChoice(choice)}
                >
                  {withRomajiLabel(choice)}
                </button>
              ))}
            </div>
          )}

          {state?.state === "playing" && state.mode === "text" && (
            <form className="panel-form answer-box" onSubmit={onSubmitText}>
              <label>
                <span>Réponse (titre ou artiste)</span>
                <Select<AnswerSelectOption, false>
                  classNamePrefix="answer-select"
                  inputId="answer-select-input"
                  unstyled
                  options={answerSelectOptions}
                  value={selectedAnswerOption}
                  onInputChange={(inputValue: string, actionMeta: InputActionMeta) => {
                    if (actionMeta.action === "input-change") {
                      setAnswer(inputValue.slice(0, 80));
                      return;
                    }
                    if (actionMeta.action === "clear") {
                      setAnswer("");
                    }
                  }}
                  onChange={(option: SingleValue<AnswerSelectOption>) => {
                    if (!option) return;
                    setAnswer(option.value.slice(0, 80));
                  }}
                  placeholder="Ex: Daft Punk"
                  noOptionsMessage={() =>
                    typedAnswer.length <= 0
                      ? "Tape un titre ou un artiste"
                      : typedAnswer.length < 3
                        ? "Tape au moins 3 caractères"
                        : answerSeedIsLoading
                          ? "Chargement de la playlist..."
                          : "Aucune suggestion"
                  }
                  isLoading={typedAnswer.length >= 1 && answerSeedIsLoading && answerSelectOptions.length <= 0}
                  openMenuOnFocus
                  blurInputOnSelect={false}
                  isDisabled={textLocked || answerMutation.isPending}
                />
              </label>
              <button
                className="solid-btn"
                type="submit"
                disabled={answerMutation.isPending || !session.playerId || textLocked}
              >
                {textLocked ? "Réponse envoyée" : answerMutation.isPending ? "Envoi..." : "Valider"}
              </button>
            </form>
          )}

          {(state?.state === "reveal" || state?.state === "leaderboard") &&
            state?.reveal && (
              <div className="reveal-box large reveal-glass">
                <div className="reveal-cover">
                  {revealArtwork ? (
                    <img src={revealArtwork} alt={`${state.reveal.title} cover`} />
                  ) : (
                    <div className="reveal-cover-fallback" aria-hidden="true" />
                  )}
                </div>
                <div className="reveal-content">
                  <p className="kicker">Reveal</p>
                  <h3 className="reveal-title">
                    {withRomajiLabel(state.reveal.title, state.reveal.titleRomaji)}
                  </h3>
                  <p className="reveal-artist">
                    {withRomajiLabel(state.reveal.artist, state.reveal.artistRomaji)}
                  </p>
                </div>
              </div>
            )}

          {state?.state === "results" && (
            <div className="podium-panel">
              <p className="kicker">Final</p>
              <h3 className="podium-title">Podium final</h3>
              <div className="podium-grid">
                {podiumSlots.map((slot) => (
                  <article
                    key={slot.rank}
                    className={`podium-step ${slot.tone}${slot.entry ? "" : " empty"}`}
                  >
                    <p className="podium-rank">#{slot.rank}</p>
                    <strong>{slot.entry?.displayName ?? "Aucun joueur"}</strong>
                    <span>{slot.entry ? `${slot.entry.score} pts` : "—"}</span>
                  </article>
                ))}
              </div>
              <div className="waiting-actions">
                <button className="ghost-btn" type="button" onClick={leaveRoom}>
                  Quitter la room
                </button>
                {isHost ? (
                  <button className="solid-btn" type="button" onClick={() => replayMutation.mutate()}>
                    {replayMutation.isPending ? "Retour lobby..." : "Rejouer"}
                  </button>
                ) : (
                  <p className="status">Le host peut relancer vers le lobby.</p>
                )}
              </div>
            </div>
          )}

          {!isResults && activeYoutubeEmbed && (
          <div className="blindtest-video-shell">
            <iframe
              ref={youtubeIframeRef}
              key={`${stableYoutubePlayback?.key ?? "none"}|${iframeEpoch}`}
              className={revealVideoActive ? "blindtest-video-reveal" : "blindtest-video-hidden"}
              src={activeYoutubeEmbed}
              title="Blindtest playback"
              allow="autoplay; encrypted-media"
              onError={() => {
                setAudioError(true);
              }}
            />
          </div>
        )}

          <p
            className={
              snapshotQuery.isError ||
              answerMutation.isError ||
              (startMutation.isError && !isNonBlockingStartError) ||
              sourceModeMutation.isError ||
              publicPlaylistMutation.isError ||
              chatMutation.isError ||
              readyMutation.isError ||
              kickMutation.isError ||
              replayMutation.isError ||
              skipMutation.isError
                ? "status error"
                : "status"
            }
          >
            {startErrorCode === "NO_TRACKS_FOUND" &&
              "Aucune chanson jouable trouvée pour le moment. Réessaie dans quelques secondes."}
            {startErrorCode === "SPOTIFY_RATE_LIMITED" &&
              `Spotify limite temporairement les requêtes. Réessaye dans ${spotifyCooldownRemainingSec}s.`}
            {startErrorCode === "SOURCE_NOT_SET" && "Le host doit choisir une playlist avant de lancer."}
            {startErrorCode === "PLAYER_NOT_FOUND" && "Ta session joueur a expiré. Rejoins la room."}
            {startErrorCode === "PLAYERS_LIBRARY_NOT_READY" &&
              "Le mode Liked Songs nécessite au moins un joueur avec un compte musical connecté."}
            {isWaitingLobby &&
              state?.sourceMode === "players_liked" &&
              state.poolBuild.status === "building" &&
              "Préparation de la playlist des joueurs... lancement automatique dès que c'est prêt."}
            {isWaitingLobby &&
              state?.sourceMode === "public_playlist" &&
              startRetryRemainingMs > 0 &&
              "Préparation de la playlist... lancement automatique dès que c'est prêt."}
            {startErrorCode === "HOST_ONLY" && "Seul le host peut lancer la partie."}
            {sourceModeErrorCode === "HOST_ONLY" && "Seul le host peut changer le mode source."}
            {publicPlaylistErrorCode === "HOST_ONLY" && "Seul le host peut choisir la playlist publique."}
            {readyErrorCode === "INVALID_STATE" && "Le statut prêt se gère uniquement dans le lobby."}
            {readyErrorCode === "PLAYER_NOT_FOUND" && "Ta session joueur a expiré. Rejoins la room."}
            {kickErrorCode === "HOST_ONLY" && "Seul le host peut éjecter un joueur."}
            {replayErrorCode === "HOST_ONLY" && "Seul le host peut relancer une partie."}
            {skipErrorCode === "HOST_ONLY" && "Seul le host peut passer automatiquement la manche."}
            {skipErrorCode === "INVALID_STATE" && "La manche ne peut pas être passée dans cet état."}
            {chatMutation.isError && "Impossible d'envoyer le message."}
            {!session.playerId && "Tu dois rejoindre la room pour répondre."}
            {snapshotQuery.isError && "Synchronisation impossible."}
            {answerMutation.isError && "Réponse refusée."}
            {audioError && !usingYouTubePlayback && "Erreur audio: extrait indisponible."}
          </p>
        </div>

        {!isResults && (
          <aside className="arena-side meta-side">
            <h2 className="side-title">Chat</h2>
            <div ref={chatLogRef} className="room-chat-log">
              {chatMessages.map((message) => (
                <p key={message.id} className="room-chat-message">
                  <strong>{message.displayName}</strong>
                  <span>{message.text}</span>
                </p>
              ))}
              {chatMessages.length <= 0 && (
                <p className="room-chat-empty">Aucun message pour l'instant.</p>
              )}
              <div ref={chatEndRef} className="room-chat-end" />
            </div>
            <form className="panel-form" onSubmit={onSubmitChat}>
              <label>
                <span>Message</span>
                <input
                  value={chatInput}
                  onChange={(event) => setChatInput(event.currentTarget.value)}
                  maxLength={400}
                  placeholder="Ecris a la room..."
                />
              </label>
              <button
                className="solid-btn"
                type="submit"
                disabled={chatMutation.isPending || !session.playerId}
              >
                {chatMutation.isPending ? "Envoi..." : "Envoyer"}
              </button>
            </form>
            <button className="ghost-btn" type="button" onClick={leaveRoom}>
              Quitter la room
            </button>
          </aside>
        )}
      </article>

      <audio
        ref={audioRef}
        className="blindtest-audio"
        preload="auto"
        onError={() => setAudioError(true)}
      >
        <track kind="captions" />
      </audio>
    </section>
  );
}
