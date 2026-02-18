import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { getRoomResults } from "../../lib/api";

export function ResultsPage() {
  const { roomCode } = useParams({ from: "/results/$roomCode" });

  const resultsQuery = useQuery({
    queryKey: ["room-results", roomCode],
    queryFn: () => getRoomResults(roomCode),
    refetchInterval: 4_000,
  });

  return (
    <section className="card stack screen-enter">
      <p className="eyebrow">Scoreboard</p>
      <h2 className="section-title section-title-neon">Resultats</h2>
      <p className="section-copy">Classement actuel de la room {roomCode}</p>

      {resultsQuery.isError && (
        <p className="status status-error">Impossible de charger le classement.</p>
      )}

      {!resultsQuery.isError && (
        <ol className="scoreboard">
          {(resultsQuery.data?.ranking ?? []).map((entry) => (
            <li key={entry.playerId}>
              <strong>#{entry.rank}</strong> {entry.displayName} · {entry.score} pts · streak max{" "}
              {entry.maxStreak}
            </li>
          ))}
        </ol>
      )}

      <div className="button-row">
        <Link className="btn btn-secondary" to="/">
          Retour accueil
        </Link>
      </div>
    </section>
  );
}
