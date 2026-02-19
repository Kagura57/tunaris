import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { startRoom, submitRoomAnswer } from "../../../lib/api";
import { fetchLiveRoomState } from "../../../lib/realtime";
import { useGameStore } from "../../../stores/gameStore";

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
  if (phase === "reveal") {
    return clamp01((REVEAL_MS - remainingMs) / REVEAL_MS);
  }
  if (phase === "leaderboard") {
    return clamp01((LEADERBOARD_MS - remainingMs) / LEADERBOARD_MS);
  }
  return 0;
}

const WAVE_BARS = Array.from({ length: 48 }, (_, index) => ({
  key: index,
  heightPercent: 22 + ((index * 17) % 70),
  delaySec: (index % 8) * 0.08,
}));

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
    mutationFn: () =>
      startRoom({
        roomCode,
        categoryQuery: session.categoryQuery || "spotify:popular",
      }),
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
  const remainingMs = useMemo(() => {
    if (!state?.deadlineMs) return null;
    return state.deadlineMs - clockNow;
  }, [clockNow, state?.deadlineMs]);
  const progress = phaseProgress(state?.state, remainingMs);
  const youtubePlayback = useMemo(() => {
    if (!state?.media?.embedUrl || !state.media.trackId) return null;
    if (state.media.provider !== "youtube" && state.media.provider !== "ytmusic") return null;
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
      state?.state === "countdown" ||
      state?.state === "playing" ||
      state?.state === undefined;
    if (shouldClear) {
      setStableYoutubePlayback(null);
    }
  }, [state?.state, youtubePlayback]);

  const activeYoutubeEmbed = stableYoutubePlayback?.embedUrl ?? null;
  const usingYouTubePlayback = Boolean(activeYoutubeEmbed);
  const revealVideoActive = state?.state === "reveal" && usingYouTubePlayback;
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

  function leaveRoom() {
    clearSession();
    navigate({ to: "/join" });
  }

  return (
    <section className="blindtest-stage">
      <article className="stage-main arena-layout">
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

        <div className="gameplay-center">
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

          {state?.state === "waiting" && (
            <div className="waiting-box">
              <h2>Room prête, lance la partie quand vous êtes chauds.</h2>
              <div className="waiting-actions">
                <button
                  className="solid-btn"
                  onClick={() => startMutation.mutate()}
                  disabled={startMutation.isPending}
                >
                  {startMutation.isPending ? "Lancement..." : "Démarrer le blindtest"}
                </button>
                <Link className="ghost-btn" to="/room/$roomCode/view" params={{ roomCode }}>
                  Ouvrir projection
                </Link>
              </div>
            </div>
          )}

          {state?.state === "playing" && state.mode === "mcq" && (
            <>
              <div className="mcq-grid">
                {(state.choices ?? []).map((choice) => (
                  <button
                    key={choice}
                    className={`choice-btn${submittedMcq?.round === state.round && submittedMcq.choice === choice ? " selected" : ""}`}
                    disabled={answerMutation.isPending || !session.playerId || mcqLocked}
                    onClick={() => onSelectChoice(choice)}
                  >
                    {choice}
                  </button>
                ))}
              </div>
              {mcqLocked && submittedMcq && (
                <p className="answer-lock">Réponse verrouillée: {submittedMcq.choice}</p>
              )}
            </>
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
                {textLocked ? "Réponse verrouillée" : answerMutation.isPending ? "Envoi..." : "Valider"}
              </button>
              {textLocked && submittedText && (
                <p className="answer-lock">Réponse verrouillée: {submittedText.value}</p>
              )}
            </form>
          )}

          {(state?.state === "reveal" || state?.state === "leaderboard" || state?.state === "results") &&
            state?.reveal && (
              <div className="reveal-box large">
                <p className="kicker">Reveal</p>
                <h3>
                  {state.reveal.title} - {state.reveal.artist}
                </h3>
                <p>Réponse attendue: {state.reveal.acceptedAnswer}</p>
              </div>
            )}

          {activeYoutubeEmbed && (
            <iframe
              key={`${stableYoutubePlayback?.key ?? "none"}|${iframeEpoch}`}
              className={revealVideoActive ? "blindtest-video-reveal" : "blindtest-video-hidden"}
              src={activeYoutubeEmbed}
              title="Blindtest playback"
              allow="autoplay; encrypted-media"
            />
          )}

          <p
            className={
              snapshotQuery.isError || answerMutation.isError || startMutation.isError
                ? "status error"
                : "status"
            }
          >
            {startErrorCode === "NO_TRACKS_FOUND" &&
              "Aucune piste YouTube jouable trouvée. Change de playlist/source et vérifie YOUTUBE_API_KEY."}
            {!session.playerId && "Tu dois rejoindre la room pour répondre."}
            {snapshotQuery.isError && "Synchronisation impossible."}
            {answerMutation.isError && "Réponse refusée."}
            {audioError && !usingYouTubePlayback && "Erreur audio: extrait indisponible."}
          </p>
        </div>

        <aside className="arena-side meta-side">
          <h2 className="side-title">Chat</h2>
          <p className="panel-copy">Le chat joueur arrive ici (roadmap).</p>
          <button className="ghost-btn" type="button" onClick={leaveRoom}>
            Quitter la room
          </button>
        </aside>
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
