import { FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toRomaji } from "wanakana";
import { createRoom, getPublicRooms, joinRoom } from "../lib/api";
import { useGameStore } from "../stores/gameStore";

function withRomajiLabel(value: string) {
  if (!value) return value;
  const romaji = toRomaji(value).trim();
  if (!romaji || romaji.toLowerCase() === value.toLowerCase()) return value;
  return romaji;
}

export function HomePage() {
  const navigate = useNavigate();
  const setSession = useGameStore((state) => state.setSession);
  const session = useGameStore((state) => state.session);
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
    mutationFn: (input: { roomCode: string; displayName: string }) =>
      joinRoom({
        roomCode: input.roomCode.trim().toUpperCase(),
        displayName: input.displayName.trim() || "Player One",
      }),
    onSuccess: (result, input) => {
      const normalizedCode = input.roomCode.trim().toUpperCase();
      const knownRoom = (publicRoomsQuery.data?.rooms ?? []).find((room) => room.roomCode === normalizedCode);
      setSession({
        roomCode: normalizedCode,
        playerId: result.playerId,
        displayName: input.displayName.trim() || "Player One",
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
    joinMutation.mutate({
      roomCode: joinRoomCode.trim(),
      displayName: joinDisplayName.trim(),
    });
  }

  function onJoinPublicRoom(roomCode: string) {
    const normalizedCode = roomCode.trim().toUpperCase();
    const cachedDisplayName = session.displayName.trim();
    const hasCachedPseudo = cachedDisplayName.length > 0 && cachedDisplayName !== "Player One";
    const suggestedFromInputs = joinDisplayName.trim() || createDisplayName.trim();

    let displayName = account.userId
      ? account.name?.trim() || cachedDisplayName || suggestedFromInputs || "Player One"
      : hasCachedPseudo
        ? cachedDisplayName
        : "";

    if (!displayName) {
      const prompted = window.prompt("Choisis un pseudo pour rejoindre cette room", suggestedFromInputs || "Player One");
      if (!prompted || prompted.trim().length <= 0) return;
      displayName = prompted.trim();
      setJoinDisplayName(displayName);
      setCreateDisplayName((current) => (current === "Player One" ? displayName : current));
    }

    setJoinRoomCode(normalizedCode);
    joinMutation.mutate({
      roomCode: normalizedCode,
      displayName,
    });
  }

  return (
    <>
      <section className="home-grid home-grid-balanced home-top-grid">
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
      </article>

      <article className="panel-card">
        <h2 className="panel-title">Créer une room</h2>
        <p className="panel-copy">Crée un lobby en un clic, choisis la visibilité, puis lance la partie.</p>
        {!account.userId && (
          <p className="status">
            Astuce: connecte-toi pour lier AniList et synchroniser ta liste anime.
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
            Le host configure le mode AniList et les themes, puis lance quand tout le monde est pret.
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
      </section>
      <section className="single-panel">
        {(publicRoomsQuery.data?.rooms ?? []).length > 0 && (
          <article className="panel-card room-list-card">
            <h3 className="panel-title">Rooms publiques</h3>
            <ul className="public-room-list">
              {(publicRoomsQuery.data?.rooms ?? []).map((room) => (
                <li key={room.roomCode}>
                  <div>
                    <strong>{room.roomCode}</strong>
                    <p>
                      {room.state} · {room.playerCount} joueurs
                    </p>
                    <p>
                      Mode: {room.sourceMode === "anilist_union" ? "AniList lie" : "Anime"}
                      {room.sourceMode === "public_playlist" && room.playlistName
                        ? ` · ${withRomajiLabel(room.playlistName)}`
                        : ""}
                    </p>
                  </div>
                  <button
                    className="solid-btn"
                    type="button"
                    disabled={!room.canJoin || joinMutation.isPending}
                    onClick={() => onJoinPublicRoom(room.roomCode)}
                  >
                    {room.canJoin ? "Rejoindre" : "Fermée"}
                  </button>
                </li>
              ))}
            </ul>
          </article>
        )}
      </section>
    </>
  );
}
