export type RoomEvent =
  | { type: "round_start"; round: number; deadlineMs: number }
  | { type: "round_reveal"; round: number; correctAnswer: string }
  | { type: "game_results" };

export type RoomRealtimeEvent =
  | {
      type: "round_started";
      roomCode: string;
      round: number;
      mode: "mcq" | "text";
      deadlineMs: number;
      choices?: string[];
    }
  | {
      type: "round_reveal";
      roomCode: string;
      round: number;
      acceptedAnswer: string;
    }
  | {
      type: "leaderboard_updated";
      roomCode: string;
      round: number;
      entries: Array<{ playerId: string; score: number; rank: number }>;
    }
  | {
      type: "match_finished";
      roomCode: string;
    };
