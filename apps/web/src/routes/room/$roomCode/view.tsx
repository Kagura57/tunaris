import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { toRomaji } from "wanakana";
import { fetchLiveRoomState } from "../../../lib/realtime";

const ROUND_MS = 12_000;
const COUNTDOWN_MS = 3_000;
const REVEAL_MS = 4_000;
const LEADERBOARD_MS = 3_000;

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

const WAVE_BARS = Array.from({ length: 64 }, (_, index) => ({
  key: index,
  heightPercent: 16 + ((index * 11) % 78),
  delaySec: (index % 10) * 0.07,
}));

function revealArtworkUrl(reveal: {
  provider: "spotify" | "deezer" | "apple-music" | "tidal" | "youtube" | "animethemes";
  trackId: string;
}) {
  if (reveal.provider === "youtube") {
    return `https://i.ytimg.com/vi/${reveal.trackId}/hqdefault.jpg`;
  }
  return null;
}

function withRomajiLabel(value: string, providedRomaji?: string | null) {
  if (!value) return value;
  const romaji = providedRomaji?.trim().length ? providedRomaji.trim() : toRomaji(value).trim();
  if (!romaji || romaji.toLowerCase() === value.toLowerCase()) return value;
  return romaji;
}

export function RoomViewPage() {
  const { roomCode } = useParams({ from: "/room/$roomCode/view" });
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0);
  const [progress, setProgress] = useState(0);
  const [audioError, setAudioError] = useState(false);
  const [iframeEpoch, setIframeEpoch] = useState(0);
  const [stableYoutubePlayback, setStableYoutubePlayback] = useState<{
    key: string;
    embedUrl: string;
  } | null>(null);
  const [stableAnimePlayback, setStableAnimePlayback] = useState<{
    key: string;
    sourceUrl: string;
  } | null>(null);
  const animeVideoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastPreviewRef = useRef<string | null>(null);
  const progressStateRef = useRef<{ key: string; value: number }>({ key: "", value: 0 });
  const postRoundProgressRef = useRef<{ key: string; startedAtMs: number } | null>(null);
  const audioRetryTimeoutRef = useRef<number | null>(null);
  const userInteractionUnlockedRef = useRef(false);

  useEffect(() => {
    const id = window.setInterval(() => setClockNow(Date.now() + serverClockOffsetMs), 80);
    return () => window.clearInterval(id);
  }, [serverClockOffsetMs]);

  const snapshotQuery = useQuery({
    queryKey: ["realtime-room-view", roomCode],
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
  const animeVideoPlayback = useMemo(() => {
    if (!state?.media?.sourceUrl || !state.media.trackId) return null;
    if (state.media.provider !== "animethemes") return null;
    return {
      key: `${state.media.provider}:${state.media.trackId}`,
      sourceUrl: state.media.sourceUrl,
    };
  }, [state?.media?.provider, state?.media?.sourceUrl, state?.media?.trackId]);

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
      state?.state === "countdown" ||
      state?.state === "playing" ||
      state?.state === "results" ||
      state?.state === undefined;
    if (shouldClear) {
      setStableYoutubePlayback(null);
    }
  }, [state?.state, youtubePlayback]);

  useEffect(() => {
    if (animeVideoPlayback) {
      setStableAnimePlayback((previous) => {
        if (previous?.key === animeVideoPlayback.key && previous.sourceUrl === animeVideoPlayback.sourceUrl) {
          return previous;
        }
        return animeVideoPlayback;
      });
      return;
    }

    const shouldClear =
      state?.state === "waiting" ||
      state?.state === "countdown" ||
      state?.state === "results" ||
      state?.state === undefined;
    if (shouldClear) {
      setStableAnimePlayback(null);
    }
  }, [animeVideoPlayback, state?.state]);

  const activeYoutubeEmbed = stableYoutubePlayback?.embedUrl ?? null;
  const activeAnimeVideoSource = stableAnimePlayback?.sourceUrl ?? null;
  const usingYouTubePlayback = Boolean(activeYoutubeEmbed);
  const usingAnimeVideoPlayback = Boolean(activeAnimeVideoSource);
  const playbackStrategy = state?.playbackStrategy ?? "audio_then_reveal_video";
  const isAnimePlaybackStrategy = playbackStrategy === "single_masked_video";
  const isRevealPhase = state?.state === "reveal" || state?.state === "leaderboard";
  const revealVideoActive =
    (usingYouTubePlayback || usingAnimeVideoPlayback) &&
    ((isAnimePlaybackStrategy && (state?.state === "playing" || isRevealPhase)) ||
      (!isAnimePlaybackStrategy && isRevealPhase));
  const youtubeVideoClass = isAnimePlaybackStrategy
    ? state?.state === "playing"
      ? "blindtest-video-masked"
      : "blindtest-video-reveal"
    : isRevealPhase
      ? "blindtest-video-reveal"
      : "blindtest-video-hidden";
  const animeVideoClass =
    state?.state === "playing" ? "blindtest-video-masked" : isRevealPhase ? "blindtest-video-reveal" : "blindtest-video-hidden";
  const isResults = state?.state === "results";
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
  const roundLabel = `${state?.round ?? 0}/${state?.totalRounds ?? 0}`;
  const revealArtwork = state?.reveal ? revealArtworkUrl(state.reveal) : null;

  useEffect(() => {
    const animeVideo = animeVideoRef.current;
    if (!animeVideo || !activeAnimeVideoSource) return;
    setAudioError(false);
    if (animeVideo.currentSrc !== activeAnimeVideoSource) {
      animeVideo.src = activeAnimeVideoSource;
      animeVideo.currentTime = 0;
    }

    const playPromise = animeVideo.play();
    if (playPromise) {
      playPromise.catch(() => undefined);
    }
  }, [activeAnimeVideoSource, state?.state]);

  useEffect(() => {
    if (activeAnimeVideoSource) return;
    const animeVideo = animeVideoRef.current;
    if (!animeVideo) return;
    animeVideo.pause();
    animeVideo.removeAttribute("src");
    animeVideo.load();
  }, [activeAnimeVideoSource]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audioRetryTimeoutRef.current !== null) {
      window.clearTimeout(audioRetryTimeoutRef.current);
      audioRetryTimeoutRef.current = null;
    }

    if (isAnimePlaybackStrategy || activeYoutubeEmbed) {
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
  }, [activeYoutubeEmbed, isAnimePlaybackStrategy, state?.previewUrl, state?.state]);

  useEffect(() => {
    function unlockAudioPlayback() {
      const shouldKickIframe = Boolean(activeYoutubeEmbed) && !userInteractionUnlockedRef.current;
      userInteractionUnlockedRef.current = true;

      const audio = audioRef.current;
      if (audio && audio.src) {
        audio.play().catch(() => undefined);
      }
      const animeVideo = animeVideoRef.current;
      if (animeVideo && animeVideo.src) {
        animeVideo.play().catch(() => undefined);
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

  return (
    <section className="projection-stage">
      <article className="projection-center-stage projection-arena">
        <div className="round-strip">
          <span>Projection {roomCode}</span>
          <strong>Manche {roundLabel}</strong>
        </div>

        <div className={`sound-visual large${revealVideoActive ? " reveal-active" : ""}`}>
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

        {state?.state === "playing" && state.mode === "mcq" && state.choices && (
          <div className="projection-choices">
            {state.choices.map((choice, index) => (
              <div key={`${choice}-${index}`} className="projection-choice">
                {withRomajiLabel(choice)}
              </div>
            ))}
          </div>
        )}

        {state?.state === "playing" && state.mode === "text" && (
          <p className="projection-hint">Mode texte: trouver titre ou artiste</p>
        )}

        {(state?.state === "reveal" || state?.state === "leaderboard" || state?.state === "results") &&
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

        {!isResults && activeYoutubeEmbed && (
          <div className="blindtest-video-shell">
            <iframe
              key={`${stableYoutubePlayback?.key ?? "none"}|${iframeEpoch}`}
              className={youtubeVideoClass}
              src={activeYoutubeEmbed}
              title="Projection playback"
              allow="autoplay; encrypted-media"
              onError={() => {
                setAudioError(true);
                setIframeEpoch((value) => value + 1);
              }}
            />
          </div>
        )}
        {!isResults && activeAnimeVideoSource && (
          <div className="blindtest-video-shell">
            <video
              ref={animeVideoRef}
              className={animeVideoClass}
              src={activeAnimeVideoSource}
              preload="auto"
              autoPlay
              playsInline
              controls={false}
              onError={() => {
                setAudioError(true);
              }}
            />
          </div>
        )}

        <ol className="leaderboard-list compact">
          {(state?.leaderboard ?? []).map((entry) => (
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
      </article>

      <audio
        ref={audioRef}
        className="blindtest-audio"
        preload="auto"
        onError={() => setAudioError(true)}
      >
        <track kind="captions" />
      </audio>

      {audioError && !usingYouTubePlayback && !usingAnimeVideoPlayback && (
        <div className="projection-audio-status">
          <p className="status error">Erreur audio sur la piste en cours.</p>
        </div>
      )}
    </section>
  );
}
