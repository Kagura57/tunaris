import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { getRoomState, startRoom } from "../../lib/api";
import { useGameStore } from "../../stores/gameStore";

export function LobbyPage() {
  const navigate = useNavigate();
  const { roomCode } = useParams({ from: "/lobby/$roomCode" });
  const session = useGameStore((state) => state.session);
  const canStart = session.isHost && session.roomCode === roomCode;

  const roomStateQuery = useQuery({
    queryKey: ["room-state", roomCode],
    queryFn: () => getRoomState(roomCode),
    refetchInterval: 2_000,
  });

  const startMutation = useMutation({
    mutationFn: () =>
      startRoom({
        roomCode,
        categoryQuery: session.categoryQuery || "popular hits",
      }),
    onSuccess: () => {
      roomStateQuery.refetch();
    },
  });

  const state = roomStateQuery.data;

  return (
    <section className="card stack screen-enter">
      <p className="eyebrow">Room Control</p>
      <h2 className="section-title section-title-neon">Lobby {roomCode}</h2>
      <p className="section-copy">Synchronisation live de la room avant démarrage.</p>

      <div className="meta-grid">
        <article className="meta-tile">
          <p className="meta-label">Etat</p>
          <p className="meta-value">{state?.state ?? "loading"}</p>
        </article>
        <article className="meta-tile">
          <p className="meta-label">Joueurs</p>
          <p className="meta-value">{state?.playerCount ?? "-"}</p>
        </article>
        <article className="meta-tile">
          <p className="meta-label">Pool</p>
          <p className="meta-value">{state?.poolSize ?? "-"}</p>
        </article>
        <article className="meta-tile">
          <p className="meta-label">Categorie</p>
          <p className="meta-value">{state?.categoryQuery ?? session.categoryQuery}</p>
        </article>
      </div>

      <div className="button-row">
        {canStart && (
          <button
            className="btn btn-primary"
            onClick={() => startMutation.mutate()}
            disabled={startMutation.isPending}
          >
            {startMutation.isPending ? "Lancement..." : "Demarrer la partie"}
          </button>
        )}
        <button className="btn btn-secondary" onClick={() => roomStateQuery.refetch()}>
          Rafraichir
        </button>
        <button
          className="btn btn-secondary"
          onClick={() =>
            navigate({
              to: "/play/$roomCode",
              params: { roomCode },
            })
          }
        >
          Aller au jeu
        </button>
      </div>

      <p
        className={
          roomStateQuery.isError || startMutation.isError ? "status status-error" : "status"
        }
      >
        {roomStateQuery.isLoading && "Synchronisation du lobby..."}
        {roomStateQuery.isError && "Impossible de charger l'etat de la room."}
        {startMutation.isError && "Le lancement a echoue."}
        {startMutation.isSuccess && "Partie demarree. Passe sur l'ecran de jeu."}
      </p>
    </section>
  );
}
