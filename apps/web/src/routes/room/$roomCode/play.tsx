import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  disconnectMusicProvider,
  getMusicProviderConnectUrl,
  HttpStatusError,
  kickPlayer,
  leaveRoom as leaveRoomApi,
  refreshPlayerLibraryLinks,
  replayRoom,
  searchPlaylistsAcrossProviders,
  setPlayerLibraryContribution,
  setPlayerReady,
  setRoomPublicPlaylist,
  setRoomSourceMode,
  skipRoomRound,
  startRoom,
  submitRoomAnswer,
  type UnifiedPlaylistOption,
} from "../../../lib/api";
import { fetchLiveRoomState } from "../../../lib/realtime";
import { useGameStore } from "../../../stores/gameStore";

const ROUND_MS = 12_000;
const COUNTDOWN_MS = 3_000;
const REVEAL_MS = 4_000;
const LEADERBOARD_MS = 3_000;

type SourceMode = "public_playlist" | "players_liked";

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

function revealArtworkUrl(reveal: { provider: UnifiedPlaylistOption["provider"] | "youtube" | "apple-music" | "tidal"; trackId: string }) {
  if (reveal.provider === "youtube") {
    return `https://i.ytimg.com/vi/${reveal.trackId}/hqdefault.jpg`;
  }
  return null;
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

export function RoomPlayPage() {
  const { roomCode } = useParams({ from: "/room/$roomCode/play" });
  const navigate = useNavigate();
  const session = useGameStore((state) => state.session);
  const clearSession = useGameStore((state) => state.clearSession);
  const setLiveRound = useGameStore((state) => state.setLiveRound);
  const [answer, setAnswer] = useState("");
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [audioError, setAudioError] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [iframeEpoch, setIframeEpoch] = useState(0);
  const [stableYoutubePlayback, setStableYoutubePlayback] = useState<{
    key: string;
    embedUrl: string;
  } | null>(null);
  const [submittedMcq, setSubmittedMcq] = useState<{ round: number; choice: string } | null>(null);
  const [submittedText, setSubmittedText] = useState<{ round: number; value: string } | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>("public_playlist");
  const [playlistQuery, setPlaylistQuery] = useState("top hits");
  const [debouncedPlaylistQuery, setDebouncedPlaylistQuery] = useState("top hits");
  const [spotifyRateLimitUntilMs, setSpotifyRateLimitUntilMs] = useState<number | null>(null);
  const youtubeIframeRef = useRef<HTMLIFrameElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastPreviewRef = useRef<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setClockNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

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
  const isHost = Boolean(session.playerId && state?.hostPlayerId === session.playerId);
  const isWaitingLobby = state?.state === "waiting";
  const currentPlayer = state?.players.find((player) => player.playerId === session.playerId) ?? null;
  const typedPlaylistQuery = playlistQuery.trim();
  const normalizedPlaylistQuery = debouncedPlaylistQuery.trim();

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

  const playlistSearchQuery = useQuery({
    queryKey: ["lobby-playlist-search", normalizedPlaylistQuery],
    queryFn: async () => {
      const payload = (await searchPlaylistsAcrossProviders({
        q: normalizedPlaylistQuery,
        limit: 24,
      })) as {
        ok: boolean;
        q: string;
        playlists: unknown;
      };
      const rawPlaylists = Array.isArray(payload.playlists) ? payload.playlists : [];
      const playlists = rawPlaylists.filter(isUnifiedPlaylistOption);
      if (!Array.isArray(payload.playlists)) {
        console.error("[playlist-search] invalid backend payload shape", payload);
      }
      console.log("[playlist-search] backend payload", {
        q: payload.q,
        ok: payload.ok,
        playlistsType: Array.isArray(payload.playlists) ? "array" : typeof payload.playlists,
        playlistsCount: rawPlaylists.length,
        validPlaylistsCount: playlists.length,
        firstPlaylist: rawPlaylists[0]
          ? {
              provider: (rawPlaylists[0] as { provider?: string }).provider ?? null,
              id: (rawPlaylists[0] as { id?: string }).id ?? null,
              name: (rawPlaylists[0] as { name?: string }).name ?? null,
              trackCount: (rawPlaylists[0] as { trackCount?: number | null }).trackCount ?? null,
            }
          : null,
      });
      return {
        ok: payload.ok,
        q: payload.q,
        playlists,
      };
    },
    enabled: isWaitingLobby && isHost && sourceMode === "public_playlist" && normalizedPlaylistQuery.length >= 2,
    staleTime: 2 * 60_000,
  });
  useEffect(() => {
    if (!isWaitingLobby || !isHost || sourceMode !== "public_playlist" || normalizedPlaylistQuery.length < 2) return;
    if (playlistSearchQuery.isError) {
      console.error("[playlist-search] query failed", playlistSearchQuery.error);
      return;
    }
    if (!playlistSearchQuery.data) return;
    console.log("[playlist-search] ui mapped playlists", {
      q: playlistSearchQuery.data.q,
      count: playlistSearchQuery.data.playlists.length,
      firstPlaylist: playlistSearchQuery.data.playlists[0] ?? null,
    });
  }, [
    isHost,
    isWaitingLobby,
    normalizedPlaylistQuery.length,
    playlistSearchQuery.data,
    playlistSearchQuery.error,
    playlistSearchQuery.isError,
    sourceMode,
  ]);

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
    onSuccess: () => {
      setSpotifyRateLimitUntilMs(null);
      snapshotQuery.refetch();
    },
    onError: (error) => {
      if (error instanceof HttpStatusError && error.message === "SPOTIFY_RATE_LIMITED") {
        const retryAfterMs = error.retryAfterMs && error.retryAfterMs > 0 ? error.retryAfterMs : 10_000;
        setSpotifyRateLimitUntilMs(Date.now() + retryAfterMs);
        return;
      }
      setSpotifyRateLimitUntilMs(null);
    },
  });

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

  const contributionMutation = useMutation({
    mutationFn: (input: { provider: "spotify" | "deezer"; includeInPool: boolean }) => {
      if (!session.playerId) throw new Error("PLAYER_NOT_FOUND");
      return setPlayerLibraryContribution({
        roomCode,
        playerId: session.playerId,
        provider: input.provider,
        includeInPool: input.includeInPool,
      });
    },
    onSuccess: () => snapshotQuery.refetch(),
  });

  const refreshLinksMutation = useMutation({
    mutationFn: () => {
      if (!session.playerId) throw new Error("PLAYER_NOT_FOUND");
      return refreshPlayerLibraryLinks({
        roomCode,
        playerId: session.playerId,
      });
    },
    onSuccess: () => snapshotQuery.refetch(),
  });

  useEffect(() => {
    function onOAuthMessage(event: MessageEvent) {
      if (!event.data || typeof event.data !== "object") return;
      const payload = event.data as { source?: string; ok?: boolean };
      if (payload.source !== "tunaris-music-oauth") return;
      if (payload.ok === true && session.playerId) {
        refreshLinksMutation.mutate();
      }
    }
    window.addEventListener("message", onOAuthMessage);
    return () => window.removeEventListener("message", onOAuthMessage);
  }, [refreshLinksMutation, session.playerId]);

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

  const startErrorCode = startMutation.error instanceof Error ? startMutation.error.message : null;
  const sourceModeErrorCode = sourceModeMutation.error instanceof Error ? sourceModeMutation.error.message : null;
  const publicPlaylistErrorCode =
    publicPlaylistMutation.error instanceof Error ? publicPlaylistMutation.error.message : null;
  const contributionErrorCode =
    contributionMutation.error instanceof Error ? contributionMutation.error.message : null;
  const refreshLinksErrorCode =
    refreshLinksMutation.error instanceof Error ? refreshLinksMutation.error.message : null;
  const readyErrorCode = readyMutation.error instanceof Error ? readyMutation.error.message : null;
  const kickErrorCode = kickMutation.error instanceof Error ? kickMutation.error.message : null;
  const replayErrorCode = replayMutation.error instanceof Error ? replayMutation.error.message : null;
  const skipErrorCode = skipMutation.error instanceof Error ? skipMutation.error.message : null;
  const spotifyCooldownRemainingMs = useMemo(() => {
    if (!spotifyRateLimitUntilMs) return 0;
    return Math.max(0, spotifyRateLimitUntilMs - clockNow);
  }, [clockNow, spotifyRateLimitUntilMs]);
  const spotifyCooldownRemainingSec = Math.max(1, Math.ceil(spotifyCooldownRemainingMs / 1000));

  const remainingMs = useMemo(() => {
    if (!state?.deadlineMs) return null;
    return state.deadlineMs - clockNow;
  }, [clockNow, state?.deadlineMs]);
  const progress =
    state?.state === "reveal" || state?.state === "leaderboard"
      ? 1
      : phaseProgress(state?.state, remainingMs);
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
    const iframeId = `tunaris-youtube-${stableYoutubePlayback?.key ?? "unknown"}`;
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
      playPromise
        .then(() => setAutoplayBlocked(false))
        .catch(() => setAutoplayBlocked(true));
    }
  }, [activeYoutubeEmbed, state?.previewUrl, state?.state]);

  useEffect(() => {
    if (!activeYoutubeEmbed) return;
    setAutoplayBlocked(true);
  }, [activeYoutubeEmbed]);

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

  const activateAudio = useCallback(async () => {
    if (activeYoutubeEmbed) {
      setAutoplayBlocked(false);
      setIframeEpoch((value) => value + 1);
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    try {
      await audio.play();
      setAutoplayBlocked(false);
    } catch {
      setAutoplayBlocked(true);
    }
  }, [activeYoutubeEmbed]);

  useEffect(() => {
    if (!autoplayBlocked) return;

    function unlockFromInteraction() {
      void activateAudio();
    }

    window.addEventListener("pointerdown", unlockFromInteraction, { once: true });
    window.addEventListener("keydown", unlockFromInteraction, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlockFromInteraction);
      window.removeEventListener("keydown", unlockFromInteraction);
    };
  }, [activateAudio, autoplayBlocked]);

  function onSubmitText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state || state.state !== "playing" || state.mode !== "text") return;
    if (textLocked) return;

    const value = answer.trim();
    if (!value || !session.playerId) return;
    setSubmittedText({ round: state.round, value });
    answerMutation.mutate(value);
  }

  function onSelectChoice(choice: string) {
    if (!state || state.state !== "playing" || state.mode !== "mcq") return;
    if (!session.playerId || mcqLocked) return;
    setSubmittedMcq({ round: state.round, choice });
    answerMutation.mutate(choice);
  }

  async function onConnectProvider(provider: "spotify" | "deezer") {
    try {
      const payload = await getMusicProviderConnectUrl({
        provider,
        returnTo: `/room/${roomCode}/play`,
      });
      if (typeof window !== "undefined") {
        window.open(payload.authorizeUrl, "tunaris-music-oauth", "width=640,height=760");
      }
    } catch {
      // Keep lobby interactive even when provider OAuth is temporarily unavailable.
    }
  }

  async function onDisconnectProvider(provider: "spotify" | "deezer") {
    try {
      await disconnectMusicProvider({ provider });
      refreshLinksMutation.mutate();
    } catch {
      // Ignore transient disconnect failures in lobby controls.
    }
  }

  function onSelectSourceMode(mode: SourceMode) {
    setSourceMode(mode);
    sourceModeMutation.mutate(mode);
  }

  async function leaveRoom() {
    if (session.playerId) {
      try {
        await leaveRoomApi({ roomCode, playerId: session.playerId });
      } catch {
        // keep local leave behavior even on transient API errors
      }
    }
    clearSession();
    navigate({ to: "/" });
  }

  const playlistOptions = playlistSearchQuery.data?.playlists ?? [];
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
                  <li key={entry.playerId}>
                    <span>#{entry.rank}</span>
                    <strong>{entry.displayName}</strong>
                    <em>{entry.score} pts</em>
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
                  <span style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              </div>
            </>
          )}

          {state?.state === "waiting" && (
            <div className="waiting-box">
              <h2>Lobby: tout le monde doit être prêt avant le lancement.</h2>

              {isHost ? (
                <div className="field-block">
                  <span className="field-label">Mode de jeu (host)</span>
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
                              <strong>{playlistDisplayName(playlist.name)}</strong>
                              <p>{playlistSecondaryLabel(playlist)}</p>
                              <small>{formatTrackCountLabel(playlist.trackCount)}</small>
                            </div>
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {sourceMode === "players_liked" && (
                    <div className="panel-form">
                      <p className="status">
                        Les joueurs connectés peuvent contribuer Spotify et/ou Deezer.
                      </p>
                      <p className="status">
                        Contributeurs actifs: {state.poolBuild.contributorsCount} | Pistes prêtes: {state.poolBuild.playableTracksCount}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="status">Seul le host peut changer le mode source.</p>
              )}

              <div className="field-block">
                <span className="field-label">Ta contribution bibliothèque</span>
                {!currentPlayer?.canContributeLibrary && (
                  <p className="status">Tu es en mode invité. Connecte-toi pour contribuer tes liked songs.</p>
                )}
                {currentPlayer?.canContributeLibrary && (
                  <div className="panel-form">
                    <button
                      className="ghost-btn"
                      type="button"
                      disabled={refreshLinksMutation.isPending}
                      onClick={() => refreshLinksMutation.mutate()}
                    >
                      {refreshLinksMutation.isPending ? "Rafraîchissement..." : "Rafraîchir mes liens"}
                    </button>
                    {(["spotify", "deezer"] as const).map((provider) => {
                      const linked = currentPlayer.libraryContribution.linkedProviders[provider];
                      const included = currentPlayer.libraryContribution.includeInPool[provider];
                      return (
                        <div key={provider} className="waiting-actions">
                          <p className="status">
                            {provider === "spotify" ? "Spotify" : "Deezer"}: {linked}
                          </p>
                          {linked === "linked" ? (
                            <>
                              <button
                                className={`ghost-btn${included ? " selected" : ""}`}
                                type="button"
                                disabled={contributionMutation.isPending}
                                onClick={() =>
                                  contributionMutation.mutate({
                                    provider,
                                    includeInPool: !included,
                                  })}
                              >
                                {included ? "Retirer du pool" : "Inclure dans le pool"}
                              </button>
                              <button
                                className="ghost-btn"
                                type="button"
                                onClick={() => onDisconnectProvider(provider)}
                              >
                                Déconnecter
                              </button>
                            </>
                          ) : (
                            <button className="ghost-btn" type="button" onClick={() => onConnectProvider(provider)}>
                              Connecter {provider === "spotify" ? "Spotify" : "Deezer"}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="waiting-actions">
                <button
                  className={`ghost-btn${currentPlayer?.isReady ? " selected" : ""}`}
                  type="button"
                  disabled={!session.playerId || readyMutation.isPending}
                  onClick={() => readyMutation.mutate(!currentPlayer?.isReady)}
                >
                  {currentPlayer?.isReady ? "Je ne suis plus prêt" : "Je suis prêt"}
                </button>
                {isHost && (
                  <button
                    className="solid-btn"
                    onClick={() => startMutation.mutate()}
                    disabled={startMutation.isPending || !state.canStart}
                  >
                    {startMutation.isPending ? "Lancement..." : "Lancer la partie"}
                  </button>
                )}
                <Link className="ghost-btn" to="/room/$roomCode/view" params={{ roomCode }}>
                  Ouvrir projection
                </Link>
              </div>

              <p className="status">
                Joueurs prêts: {state.readyCount}/{state.players.length}
              </p>
              <ul className="lobby-player-list">
                {state.players.map((player) => (
                  <li key={player.playerId}>
                    <div>
                      <strong>{player.displayName}</strong>
                      <p>
                        {player.isHost ? "Host" : "Joueur"} - {player.isReady ? "Prêt" : "En attente"}
                      </p>
                      <p>
                        Spotify: {player.libraryContribution.linkedProviders.spotify}
                        {player.libraryContribution.includeInPool.spotify ? " (opt-in)" : ""}
                        {" | "}
                        Deezer: {player.libraryContribution.linkedProviders.deezer}
                        {player.libraryContribution.includeInPool.deezer ? " (opt-in)" : ""}
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
                  {choice}
                </button>
              ))}
            </div>
          )}

          {state?.state === "playing" && state.mode === "text" && (
            <form className="panel-form answer-box" onSubmit={onSubmitText}>
              <label>
                <span>Réponse (titre ou artiste)</span>
                <input
                  value={answer}
                  onChange={(event) => setAnswer(event.currentTarget.value)}
                  placeholder="Ex: Daft Punk"
                  maxLength={80}
                  disabled={textLocked || answerMutation.isPending}
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
                  <h3 className="reveal-title">{state.reveal.title}</h3>
                  <p className="reveal-artist">{state.reveal.artist}</p>
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
              startMutation.isError ||
              sourceModeMutation.isError ||
              publicPlaylistMutation.isError ||
              contributionMutation.isError ||
              refreshLinksMutation.isError ||
              readyMutation.isError ||
              kickMutation.isError ||
              replayMutation.isError ||
              skipMutation.isError
                ? "status error"
                : "status"
            }
          >
            {startErrorCode === "NO_TRACKS_FOUND" &&
              "Aucune piste YouTube jouable trouvée. Vérifie YOUTUBE_API_KEY (quota inclus) ou YOUTUBE_INVIDIOUS_INSTANCES."}
            {startErrorCode === "SPOTIFY_RATE_LIMITED" &&
              `Spotify limite temporairement les requêtes. Réessaye dans ${spotifyCooldownRemainingSec}s.`}
            {startErrorCode === "SOURCE_NOT_SET" && "Le host doit choisir une playlist avant de lancer."}
            {startErrorCode === "PLAYERS_LIBRARY_NOT_READY" &&
              "Le mode Liked Songs nécessite des joueurs connectés et opt-in."}
            {startErrorCode === "PLAYERS_LIBRARY_SYNCING" &&
              "Synchronisation des bibliothèques en cours. Réessaie dans quelques secondes."}
            {startErrorCode === "PLAYERS_NOT_READY" && "Tous les joueurs doivent être prêts."}
            {startErrorCode === "HOST_ONLY" && "Seul le host peut lancer la partie."}
            {sourceModeErrorCode === "HOST_ONLY" && "Seul le host peut changer le mode source."}
            {publicPlaylistErrorCode === "HOST_ONLY" && "Seul le host peut choisir la playlist publique."}
            {contributionErrorCode === "INVALID_STATE" && "L’opt-in bibliothèque est disponible uniquement dans le lobby."}
            {contributionErrorCode === "UNAUTHORIZED" && "Connecte ton compte Tunaris pour contribuer ta bibliothèque."}
            {contributionErrorCode === "FORBIDDEN" && "Connecte ton compte Tunaris pour contribuer ta bibliothèque."}
            {refreshLinksErrorCode === "UNAUTHORIZED" && "Connecte ton compte Tunaris pour lier Spotify/Deezer."}
            {readyErrorCode === "INVALID_STATE" && "Le statut prêt se gère uniquement dans le lobby."}
            {kickErrorCode === "HOST_ONLY" && "Seul le host peut éjecter un joueur."}
            {replayErrorCode === "HOST_ONLY" && "Seul le host peut relancer une partie."}
            {skipErrorCode === "HOST_ONLY" && "Seul le host peut passer automatiquement la manche."}
            {skipErrorCode === "INVALID_STATE" && "La manche ne peut pas être passée dans cet état."}
            {!session.playerId && "Tu dois rejoindre la room pour répondre."}
            {snapshotQuery.isError && "Synchronisation impossible."}
            {answerMutation.isError && "Réponse refusée."}
            {audioError && !usingYouTubePlayback && "Erreur audio: extrait indisponible."}
          </p>
        </div>

        {!isResults && (
          <aside className="arena-side meta-side">
            <h2 className="side-title">Chat</h2>
            <p className="panel-copy">Le chat joueur arrive ici (roadmap).</p>
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
