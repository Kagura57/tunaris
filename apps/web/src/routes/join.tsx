import { FormEvent, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { getPublicRooms, joinRoom } from "../lib/api";
import { notify } from "../lib/notify";
import { useGameStore } from "../stores/gameStore";

function joinErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "Impossible de rejoindre cette room.";
  if (error.message === "ROOM_NOT_JOINABLE") {
    return "La room est terminée et n’accepte plus de nouveaux joueurs.";
  }
  return "Impossible de rejoindre cette room.";
}

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
      notify.success("Room rejointe.");
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
    onError: (error) => {
      notify.error(joinErrorMessage(error), {
        key: "join-page:join:error",
      });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!roomCode.trim() || !displayName.trim()) return;
    joinMutation.mutate();
  }

  return (
    <section className="single-panel">
      <article className="panel-card">
        <h2 className="panel-title">Rejoindre une room</h2>
        <p className="panel-copy">Le premier joueur de la room devient host du lobby.</p>

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
