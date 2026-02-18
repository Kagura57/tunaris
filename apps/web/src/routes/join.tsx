import { FormEvent, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { joinRoom } from "../lib/api";
import { useGameStore } from "../stores/gameStore";

export function JoinPage() {
  const navigate = useNavigate();
  const setSession = useGameStore((state) => state.setSession);
  const [roomCode, setRoomCode] = useState("");
  const [displayName, setDisplayName] = useState("");

  const joinMutation = useMutation({
    mutationFn: () =>
      joinRoom({
        roomCode: roomCode.trim().toUpperCase(),
        displayName: displayName.trim(),
      }),
    onSuccess: (result) => {
      const normalizedCode = roomCode.trim().toUpperCase();
      setSession({
        roomCode: normalizedCode,
        playerId: result.playerId,
        displayName: displayName.trim(),
        isHost: false,
      });

      navigate({
        to: "/lobby/$roomCode",
        params: { roomCode: normalizedCode },
      });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!roomCode.trim() || !displayName.trim()) return;
    joinMutation.mutate();
  }

  return (
    <section className="card stack screen-enter">
      <p className="eyebrow">Player Entry</p>
      <h2 className="section-title section-title-neon">Rejoindre une room</h2>
      <p className="section-copy">Code + pseudo, puis entrée directe au lobby.</p>

      <form className="stack" onSubmit={onSubmit}>
        <label className="field">
          <span className="label">Code room</span>
          <input
            className="input"
            value={roomCode}
            onChange={(event) => setRoomCode(event.currentTarget.value)}
            maxLength={6}
            placeholder="ABC123"
          />
        </label>

        <label className="field">
          <span className="label">Pseudo</span>
          <input
            className="input"
            value={displayName}
            onChange={(event) => setDisplayName(event.currentTarget.value)}
            maxLength={24}
            placeholder="Ton nom"
          />
        </label>

        <div className="button-row">
          <button className="btn btn-primary" type="submit" disabled={joinMutation.isPending}>
            {joinMutation.isPending ? "Connexion..." : "Entrer dans le lobby"}
          </button>
        </div>
      </form>

      <p className={joinMutation.isError ? "status status-error" : "status"}>
        {joinMutation.isPending && "Connexion en cours..."}
        {joinMutation.isError && "Impossible de rejoindre cette room."}
      </p>
    </section>
  );
}
