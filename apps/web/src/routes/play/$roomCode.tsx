import { FormEvent, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { getRoomState, submitRoomAnswer } from "../../lib/api";
import { useGameStore } from "../../stores/gameStore";

export function PlayPage() {
  const navigate = useNavigate();
  const { roomCode } = useParams({ from: "/play/$roomCode" });
  const session = useGameStore((state) => state.session);
  const [answer, setAnswer] = useState("");

  const roomStateQuery = useQuery({
    queryKey: ["room-state", roomCode],
    queryFn: () => getRoomState(roomCode),
    refetchInterval: 1_500,
  });

  const answerMutation = useMutation({
    mutationFn: () =>
      submitRoomAnswer({
        roomCode,
        playerId: session.playerId ?? "",
        answer: answer.trim(),
      }),
    onSuccess: () => {
      setAnswer("");
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!answer.trim() || !session.playerId) return;
    answerMutation.mutate();
  }

  return (
    <section className="card stack screen-enter">
      <p className="eyebrow">Round Console</p>
      <h2 className="section-title section-title-neon">Partie en cours</h2>
      <p className="section-copy">Room {roomCode}</p>

      <div className="meta-grid">
        <article className="meta-tile">
          <p className="meta-label">Etat</p>
          <p className="meta-value">{roomStateQuery.data?.state ?? "loading"}</p>
        </article>
        <article className="meta-tile">
          <p className="meta-label">Round</p>
          <p className="meta-value">{roomStateQuery.data?.round ?? "-"}</p>
        </article>
        <article className="meta-tile">
          <p className="meta-label">Joueurs</p>
          <p className="meta-value">{roomStateQuery.data?.playerCount ?? "-"}</p>
        </article>
        <article className="meta-tile">
          <p className="meta-label">Player ID</p>
          <p className="meta-value">{session.playerId ?? "non connecte"}</p>
        </article>
      </div>

      <form className="stack" onSubmit={onSubmit}>
        <label className="field">
          <span className="label">Ta reponse</span>
          <input
            className="input"
            value={answer}
            onChange={(event) => setAnswer(event.currentTarget.value)}
            placeholder="Titre ou artiste"
            maxLength={80}
            disabled={!session.playerId || answerMutation.isPending}
          />
        </label>

        <div className="button-row">
          <button
            className="btn btn-primary"
            type="submit"
            disabled={!session.playerId || answerMutation.isPending || answer.trim().length === 0}
          >
            {answerMutation.isPending ? "Envoi..." : "Envoyer"}
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() =>
              navigate({
                to: "/results/$roomCode",
                params: { roomCode },
              })
            }
          >
            Voir les resultats
          </button>
        </div>
      </form>

      <p
        className={
          roomStateQuery.isError || answerMutation.isError || !session.playerId
            ? "status status-error"
            : "status"
        }
      >
        {!session.playerId && "Tu dois rejoindre la room avant de repondre."}
        {roomStateQuery.isError && "Impossible de synchroniser la room."}
        {answerMutation.isError && "Reponse refusee ou invalide."}
        {answerMutation.isSuccess && "Reponse envoyee."}
      </p>
    </section>
  );
}
