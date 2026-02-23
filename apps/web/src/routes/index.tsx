import { FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createRoom, getPublicRooms, joinRoom } from "../lib/api";
import { useGameStore } from "../stores/gameStore";

export function HomePage() {
  const navigate = useNavigate();
  const setSession = useGameStore((state) => state.setSession);
  const account = useGameStore((state) => state.account);
  const [createDisplayName, setCreateDisplayName] = useState("Player One");
  const [joinDisplayName, setJoinDisplayName] = useState("Player One");
  const [joinRoomCode, setJoinRoomCode] = useState("");
  const [isPublicRoom, setIsPublicRoom] = useState(true);

  const publicRoomsQuery = useQuery({
    queryKey: ["public-rooms"],
    queryFn: getPublicRooms,
    refetchInterval: 4_000,
  });

  const createRoomMutation = useMutation({
    mutationFn: async () => {
      const created = await createRoom({
        isPublic: isPublicRoom,
      });

      const joined = await joinRoom({
        roomCode: created.roomCode,
        displayName: createDisplayName.trim() || "Player One",
      });

      return {
        roomCode: created.roomCode,
        playerId: joined.playerId,
      };
    },
    onSuccess: (result) => {
      setSession({
        roomCode: result.roomCode,
        playerId: result.playerId,
        displayName: createDisplayName.trim() || "Player One",
        categoryQuery: "",
      });
      navigate({
        to: "/room/$roomCode/play",
        params: { roomCode: result.roomCode },
      });
    },
  });

  const joinMutation = useMutation({
    mutationFn: () =>
      joinRoom({
        roomCode: joinRoomCode.trim().toUpperCase(),
        displayName: joinDisplayName.trim() || "Player One",
      }),
    onSuccess: (result) => {
      const normalizedCode = joinRoomCode.trim().toUpperCase();
      const knownRoom = (publicRoomsQuery.data?.rooms ?? []).find((room) => room.roomCode === normalizedCode);
      setSession({
        roomCode: normalizedCode,
        playerId: result.playerId,
        displayName: joinDisplayName.trim() || "Player One",
        categoryQuery: knownRoom?.categoryQuery ?? "",
      });

      navigate({
        to: "/room/$roomCode/play",
        params: { roomCode: normalizedCode },
      });
    },
  });
  const joinErrorCode = joinMutation.error instanceof Error ? joinMutation.error.message : null;

  useEffect(() => {
    const suggestedName = account.name?.trim() ?? "";
    if (!suggestedName) return;
    setCreateDisplayName((current) => (current === "Player One" ? suggestedName : current));
    setJoinDisplayName((current) => (current === "Player One" ? suggestedName : current));
  }, [account.name]);

  function onCreate() {
    createRoomMutation.mutate();
  }

  function onJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!joinRoomCode.trim() || !joinDisplayName.trim()) return;
    joinMutation.mutate();
  }

  return (
    <section className="home-grid home-grid-balanced">
      <article className="panel-card">
        <h2 className="panel-title">Créer une room</h2>
        <p className="panel-copy">Crée un lobby en un clic, choisis la visibilité, puis lance la partie.</p>
        {!account.userId && (
          <p className="status">
            Astuce: connecte-toi pour lier Spotify/Deezer et activer le mode Liked Songs.
          </p>
        )}

        <div className="panel-form">
          <label>
            <span>Pseudo</span>
            <input
              value={createDisplayName}
              onChange={(event) => setCreateDisplayName(event.currentTarget.value)}
              maxLength={24}
              placeholder="Ton pseudo"
            />
          </label>

          <div className="field-block">
            <span className="field-label">Visibilité</span>
            <div className="source-preset-grid">
              <button
                type="button"
                className={`source-preset-btn${isPublicRoom ? " active" : ""}`}
                onClick={() => setIsPublicRoom(true)}
              >
                <strong>Partie publique</strong>
                <span>Visible dans la liste publique</span>
              </button>
              <button
                type="button"
                className={`source-preset-btn${!isPublicRoom ? " active" : ""}`}
                onClick={() => setIsPublicRoom(false)}
              >
                <strong>Partie privée</strong>
                <span>Accessible avec le code room</span>
              </button>
            </div>
          </div>

          <p className="status">
            Le host choisit la playlist dans le lobby, puis lance seulement quand tout le monde est prêt.
          </p>

          <button
            id="create-room"
            className="solid-btn"
            type="button"
            onClick={onCreate}
            disabled={createRoomMutation.isPending || joinMutation.isPending}
          >
            {createRoomMutation.isPending ? "Création..." : "Créer une room"}
          </button>
        </div>

        <p className={createRoomMutation.isError ? "status error" : "status"}>
          {createRoomMutation.isError && "Impossible de créer la room."}
        </p>
      </article>

      <article className="panel-card">
        <h2 className="panel-title">Rejoindre une room</h2>
        <p className="panel-copy">Le premier joueur de la room devient host du lobby.</p>

        <form className="panel-form" onSubmit={onJoin}>
          <label>
            <span>Code room</span>
            <input
              value={joinRoomCode}
              onChange={(event) => setJoinRoomCode(event.currentTarget.value)}
              maxLength={6}
              placeholder="ABC123"
            />
          </label>

          <label>
            <span>Pseudo</span>
            <input
              value={joinDisplayName}
              onChange={(event) => setJoinDisplayName(event.currentTarget.value)}
              maxLength={24}
              placeholder="Ton pseudo"
            />
          </label>

          <button className="solid-btn" type="submit" disabled={joinMutation.isPending || createRoomMutation.isPending}>
            {joinMutation.isPending ? "Connexion..." : "Entrer dans la room"}
          </button>
        </form>

        <p className={joinMutation.isError ? "status error" : "status"}>
          {joinErrorCode === "ROOM_NOT_JOINABLE" && "La room est terminée et n’accepte plus de nouveaux joueurs."}
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
                onClick={() => setJoinRoomCode(room.roomCode)}
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
