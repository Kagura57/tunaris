export type RoomEvent =
  | { type: "round_start"; round: number; deadlineMs: number }
  | { type: "round_reveal"; round: number; correctAnswer: string }
  | { type: "game_results" };
