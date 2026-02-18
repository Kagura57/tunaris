import { useMutation } from "@tanstack/react-query";
import { createRoomWithFallback } from "../lib/api";

export function HomePage() {
  const createRoomMutation = useMutation({
    mutationFn: createRoomWithFallback,
  });

  return (
    <section>
      <p>Application prête. Crée une room pour démarrer.</p>
      <button
        id="create-room"
        onClick={() => createRoomMutation.mutate()}
        style={{
          padding: "10px 14px",
          borderRadius: 8,
          border: "1px solid #111",
          background: "#111",
          color: "#fff",
        }}
      >
        Créer une room
      </button>
      <p id="status" style={{ marginTop: 12, color: "#444" }}>
        {createRoomMutation.isPending && "Création de la room..."}
        {createRoomMutation.isSuccess &&
          `Room créée (${createRoomMutation.data.source}) : ${createRoomMutation.data.roomCode}`}
        {createRoomMutation.isError && "Erreur pendant la création de la room."}
        {!createRoomMutation.isPending &&
          !createRoomMutation.isSuccess &&
          !createRoomMutation.isError &&
          "En attente d'action..."}
      </p>
    </section>
  );
}
