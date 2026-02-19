import { FormEvent, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { getPublicRooms, joinRoom } from "../lib/api";
import { useGameStore } from "../stores/gameStore";

export function JoinPage() {
  const navigate = useNavigate();
  const setSession = useGameStore((state) => state.setSession);
  const [roomCode, setRoomCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const publicRoomsQuery = useQuery({
    queryKey: ["public-rooms"],
    queryFn: getPublicRooms,
    refetchInterval: 4_000,
  });

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
      });

      navigate({
        to: "/room/$roomCode/play",
        params: { roomCode: normalizedCode },
      });
    },
  });
  const joinErrorCode = joinMutation.error instanceof Error ? joinMutation.error.message : null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!roomCode.trim() || !displayName.trim()) return;
    joinMutation.mutate();
  }

  return (
    <section className="single-panel">
      <article className="panel-card">
        <h2 className="panel-title">Rejoindre une room</h2>
        <p className="panel-copy">Aucune distinction host/joueur: entre et joue.</p>

        <form className="panel-form" onSubmit={onSubmit}>
          <label>
            <span>Code room</span>
            <input
              value={roomCode}
              onChange={(event) => setRoomCode(event.currentTarget.value)}
              maxLength={6}
              placeholder="ABC123"
            />
          </label>

          <label>
            <span>Pseudo</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.currentTarget.value)}
              maxLength={24}
              placeholder="Ton pseudo"
            />
          </label>

          <button className="solid-btn" type="submit" disabled={joinMutation.isPending}>
            {joinMutation.isPending ? "Connexion..." : "Entrer dans la room"}
          </button>
        </form>

        <p className={joinMutation.isError ? "status error" : "status"}>
          {joinErrorCode === "ROOM_NOT_JOINABLE" && "La room n’accepte plus de nouveaux joueurs."}
          {joinMutation.isError && joinErrorCode !== "ROOM_NOT_JOINABLE" && "Impossible de rejoindre cette room."}
        </p>

        <h3 className="panel-title">Rooms publiques</h3>
        <ul className="public-room-list">
          {(publicRoomsQuery.data?.rooms ?? []).map((room) => (
            <li key={room.roomCode}>
              <div>
                <strong>{room.roomCode}</strong>
                <p>
                  {room.state} - {room.playerCount} joueurs
                </p>
              </div>
              <button
                className="ghost-btn"
                type="button"
                disabled={!room.canJoin}
                onClick={() => setRoomCode(room.roomCode)}
              >
                {room.canJoin ? "Utiliser" : "Locked"}
              </button>
            </li>
          ))}
        </ul>
      </article>
    </section>
  );
}
