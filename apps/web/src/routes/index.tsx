import { FormEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  createRoom,
  getPublicRooms,
  joinRoom,
  searchPlaylistsAcrossProviders,
  type PublicRoomSummary,
  type UnifiedPlaylistOption,
} from "../lib/api";
import { useGameStore } from "../stores/gameStore";

type SourceMode = "playlist" | "anilist";

const FALLBACK_PLAYLIST_OPTION: UnifiedPlaylistOption = {
  provider: "spotify",
  id: "spotify-popular-auto",
  name: "Featured Spotify (auto)",
  description: "Fallback featured playlists",
  imageUrl: null,
  externalUrl: "https://open.spotify.com",
  owner: "Spotify",
  trackCount: null,
  sourceQuery: "spotify:popular",
};

function formatRoomLabel(room: PublicRoomSummary) {
  const roundLabel = room.totalRounds > 0 ? `${room.round}/${room.totalRounds}` : "setup";
  return `${room.state} - ${room.playerCount} joueurs - ${roundLabel}`;
}

function providerLabel(provider: UnifiedPlaylistOption["provider"]) {
  if (provider === "spotify") return "Spotify";
  return "Deezer";
}

function buildSourceQuery(input: {
  sourceMode: SourceMode;
  selectedPlaylist: UnifiedPlaylistOption | null;
  aniListUsers: string;
}) {
  if (input.sourceMode === "anilist") {
    return `anilist:users:${input.aniListUsers.trim()}`;
  }
  return input.selectedPlaylist?.sourceQuery ?? "";
}

function isSourceReady(input: {
  sourceMode: SourceMode;
  selectedPlaylist: UnifiedPlaylistOption | null;
  aniListUsers: string;
}) {
  if (input.sourceMode === "anilist") {
    return input.aniListUsers.trim().length > 0;
  }
  return input.selectedPlaylist !== null;
}

export function HomePage() {
  const navigate = useNavigate();
  const setSession = useGameStore((state) => state.setSession);
  const [displayName, setDisplayName] = useState("Player One");
  const [isPublicRoom, setIsPublicRoom] = useState(true);
  const [sourceMode, setSourceMode] = useState<SourceMode>("playlist");
  const [playlistQuery, setPlaylistQuery] = useState("top hits");
  const [selectedPlaylist, setSelectedPlaylist] = useState<UnifiedPlaylistOption | null>(
    FALLBACK_PLAYLIST_OPTION,
  );
  const [aniListUsers, setAniListUsers] = useState("");

  const normalizedPlaylistQuery = playlistQuery.trim();

  const playlistSearchQuery = useQuery({
    queryKey: ["unified-playlist-search", normalizedPlaylistQuery],
    queryFn: () => searchPlaylistsAcrossProviders({ q: normalizedPlaylistQuery, limit: 24 }),
    enabled: sourceMode === "playlist" && normalizedPlaylistQuery.length >= 2,
    staleTime: 2 * 60_000,
  });

  const publicRoomsQuery = useQuery({
    queryKey: ["public-rooms"],
    queryFn: getPublicRooms,
    refetchInterval: 4_000,
  });

  const playlistOptions = useMemo(() => {
    const remote = playlistSearchQuery.data?.playlists ?? [];
    return remote.length > 0 ? remote : [FALLBACK_PLAYLIST_OPTION];
  }, [playlistSearchQuery.data?.playlists]);

  useEffect(() => {
    if (sourceMode !== "playlist") {
      setSelectedPlaylist(null);
      return;
    }
    if (
      selectedPlaylist &&
      playlistOptions.some((item) => item.sourceQuery === selectedPlaylist.sourceQuery)
    ) {
      return;
    }
    setSelectedPlaylist(playlistOptions[0] ?? null);
  }, [playlistOptions, selectedPlaylist, sourceMode]);

  const createRoomMutation = useMutation({
    mutationFn: async () => {
      const categoryQuery = buildSourceQuery({
        sourceMode,
        selectedPlaylist,
        aniListUsers,
      });

      const created = await createRoom({
        categoryQuery,
        isPublic: isPublicRoom,
      });

      const joined = await joinRoom({
        roomCode: created.roomCode,
        displayName: displayName.trim() || "Player One",
      });

      return {
        roomCode: created.roomCode,
        playerId: joined.playerId,
        categoryQuery,
      };
    },
    onSuccess: (result) => {
      setSession({
        roomCode: result.roomCode,
        playerId: result.playerId,
        displayName: displayName.trim() || "Player One",
        categoryQuery: result.categoryQuery,
      });
      navigate({
        to: "/room/$roomCode/play",
        params: { roomCode: result.roomCode },
      });
    },
  });

  const quickJoinMutation = useMutation({
    mutationFn: async (room: PublicRoomSummary) => {
      const joined = await joinRoom({
        roomCode: room.roomCode,
        displayName: displayName.trim() || "Player One",
      });
      return { room, joined };
    },
    onSuccess: ({ room, joined }) => {
      setSession({
        roomCode: room.roomCode,
        playerId: joined.playerId,
        displayName: displayName.trim() || "Player One",
        categoryQuery: room.categoryQuery,
      });
      navigate({
        to: "/room/$roomCode/play",
        params: { roomCode: room.roomCode },
      });
    },
  });

  const sourceQueryPreview = useMemo(() => {
    return buildSourceQuery({
      sourceMode,
      selectedPlaylist,
      aniListUsers,
    });
  }, [aniListUsers, selectedPlaylist, sourceMode]);

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !isSourceReady({
        sourceMode,
        selectedPlaylist,
        aniListUsers,
      })
    ) {
      return;
    }
    createRoomMutation.mutate();
  }

  return (
    <section className="home-grid home-grid-balanced">
      <article className="panel-card">
        <h2 className="panel-title">Créer une room</h2>
        <form className="panel-form" onSubmit={onCreate}>
          <label>
            <span>Pseudo</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.currentTarget.value)}
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
                <span>Visible dans la liste publique (join setup uniquement)</span>
              </button>
              <button
                type="button"
                className={`source-preset-btn${!isPublicRoom ? " active" : ""}`}
                onClick={() => setIsPublicRoom(false)}
              >
                <strong>Partie privée</strong>
                <span>Accessible uniquement avec le code room</span>
              </button>
            </div>
          </div>

          <div className="field-block">
            <span className="field-label">Source blindtest</span>
            <div className="source-preset-grid">
              <button
                type="button"
                className={`source-preset-btn${sourceMode === "playlist" ? " active" : ""}`}
                onClick={() => setSourceMode("playlist")}
              >
                <strong>Playlists musique</strong>
                <span>Recherche Spotify + Deezer unifiée</span>
              </button>
              <button
                type="button"
                className={`source-preset-btn${sourceMode === "anilist" ? " active" : ""}`}
                onClick={() => setSourceMode("anilist")}
              >
                <strong>AniList anime</strong>
                <span>Openings/endings depuis la liste utilisateur</span>
              </button>
            </div>
          </div>

          {sourceMode === "playlist" && (
            <div className="field-block">
              <label>
                <span>Recherche playlist (Spotify + Deezer)</span>
                <input
                  value={playlistQuery}
                  onChange={(event) => setPlaylistQuery(event.currentTarget.value)}
                  maxLength={120}
                  placeholder="Ex: anime openings, top france, rap 2000"
                />
              </label>
              {normalizedPlaylistQuery.length < 2 && (
                <p className="status">Tape au moins 2 caractères pour chercher une playlist.</p>
              )}
              {playlistSearchQuery.isError && (
                <p className="status error">Recherche playlists indisponible.</p>
              )}
              <div className="playlist-card-grid">
                {playlistOptions.map((playlist) => (
                  <button
                    key={`${playlist.provider}:${playlist.id}`}
                    type="button"
                    className={`playlist-card-btn${selectedPlaylist?.sourceQuery === playlist.sourceQuery ? " active" : ""}`}
                    onClick={() => setSelectedPlaylist(playlist)}
                  >
                    {playlist.imageUrl ? (
                      <img src={playlist.imageUrl} alt={playlist.name} loading="lazy" />
                    ) : (
                      <div className="playlist-card-placeholder" aria-hidden="true" />
                    )}
                    <div>
                      <strong>{playlist.name}</strong>
                      <p>
                        {providerLabel(playlist.provider)} - {playlist.owner ?? "Editorial"}
                      </p>
                      <small>
                        {playlist.trackCount ? `${playlist.trackCount} titres` : "Track count inconnu"}
                      </small>
                    </div>
                  </button>
                ))}
              </div>
              {(playlistSearchQuery.data?.playlists ?? []).length === 0 &&
                !playlistSearchQuery.isFetching &&
                normalizedPlaylistQuery.length >= 2 && (
                  <p className="status">Aucun résultat direct, fallback featured Spotify utilisé.</p>
                )}
            </div>
          )}

          {sourceMode === "anilist" && (
            <label>
              <span>AniList users (csv)</span>
              <input
                value={aniListUsers}
                onChange={(event) => setAniListUsers(event.currentTarget.value)}
                maxLength={160}
                placeholder="userA,userB,userC"
              />
            </label>
          )}

          <p className="status">Source utilisée: {sourceQueryPreview || "-"}</p>

          <button
            id="create-room"
            className="solid-btn"
            type="submit"
            disabled={
              createRoomMutation.isPending ||
              !isSourceReady({
                sourceMode,
                selectedPlaylist,
                aniListUsers,
              })
            }
          >
            {createRoomMutation.isPending ? "Création..." : "Créer et jouer"}
          </button>
        </form>

        <p className={createRoomMutation.isError ? "status error" : "status"}>
          {createRoomMutation.isError && "Impossible de créer la room."}
        </p>

        <Link className="text-link" to="/join">
          J’ai déjà un code room
        </Link>
      </article>

      <article className="panel-card">
        <h2 className="panel-title">Parties publiques</h2>
        <p className="panel-copy">
          Rejoins une room publique en setup. Une fois lancée, la room n’accepte plus de nouveaux joueurs.
        </p>
        <ul className="public-room-list">
          {(publicRoomsQuery.data?.rooms ?? []).map((room) => (
            <li key={room.roomCode}>
              <div>
                <strong>{room.roomCode}</strong>
                <p>{formatRoomLabel(room)}</p>
              </div>
              <button
                className="ghost-btn"
                type="button"
                disabled={quickJoinMutation.isPending || !room.canJoin}
                onClick={() => quickJoinMutation.mutate(room)}
              >
                {room.canJoin ? "Rejoindre" : "Indisponible"}
              </button>
            </li>
          ))}
        </ul>
        {publicRoomsQuery.data?.rooms.length === 0 && (
          <p className="status">Aucune partie publique active pour le moment.</p>
        )}
      </article>
    </section>
  );
}
