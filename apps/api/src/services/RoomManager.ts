export type GameState =
  | "waiting"
  | "countdown"
  | "playing"
  | "reveal"
  | "leaderboard"
  | "results";

export type RoundAnswer = {
  value: string;
  submittedAtMs: number;
};

export type ClosedRound = {
  round: number;
  startedAtMs: number;
  deadlineMs: number;
  answers: Map<string, RoundAnswer>;
};

type StartGameInput = {
  nowMs: number;
  countdownMs: number;
  totalRounds: number;
};

type TickInput = {
  nowMs: number;
  roundMs: number;
  revealMs: number;
  leaderboardMs: number;
};

type TickResult = {
  transitioned: boolean;
  closedRounds: ClosedRound[];
};

export class RoomManager {
  private gameState: GameState = "waiting";
  private currentRound = 0;
  private roundDeadlineMs: number | null = null;
  private roundStartedAtMs: number | null = null;
  private plannedTotalRounds = 0;
  private answers = new Map<string, RoundAnswer>();

  constructor(public readonly roomCode: string) {}

  state(): GameState {
    return this.gameState;
  }

  round(): number {
    return this.currentRound;
  }

  deadlineMs(): number | null {
    return this.roundDeadlineMs;
  }

  startedAtMs(): number | null {
    return this.roundStartedAtMs;
  }

  totalRounds(): number {
    return this.plannedTotalRounds;
  }

  startGame(input: StartGameInput) {
    if (this.gameState !== "waiting") return false;

    const safeCountdownMs = Math.max(0, input.countdownMs);
    this.currentRound = 0;
    this.roundStartedAtMs = null;
    this.answers.clear();
    this.plannedTotalRounds = Math.max(0, input.totalRounds);
    this.gameState = "countdown";
    this.roundDeadlineMs = input.nowMs + safeCountdownMs;
    return true;
  }

  forcePlayingRound(round: number, deadlineMs: number, startedAtMs?: number) {
    this.answers.clear();
    this.currentRound = Math.max(1, round);
    this.roundStartedAtMs =
      startedAtMs !== undefined ? startedAtMs : Math.max(0, deadlineMs - 15_000);
    this.roundDeadlineMs = deadlineMs;
    this.gameState = "playing";
    this.plannedTotalRounds = Math.max(this.plannedTotalRounds, this.currentRound);
  }

  tick(input: TickInput): TickResult {
    const safeRoundMs = Math.max(1, input.roundMs);
    const safeRevealMs = Math.max(0, input.revealMs);
    const safeLeaderboardMs = Math.max(0, input.leaderboardMs);
    const closedRounds: ClosedRound[] = [];
    let transitioned = false;

    while (this.roundDeadlineMs !== null && input.nowMs >= this.roundDeadlineMs) {
      const transitionAtMs = this.roundDeadlineMs;

      if (this.gameState === "countdown") {
        if (this.plannedTotalRounds <= 0) {
          this.gameState = "results";
          this.roundDeadlineMs = null;
          this.roundStartedAtMs = null;
          transitioned = true;
          break;
        }

        this.currentRound = 1;
        this.roundStartedAtMs = transitionAtMs;
        this.roundDeadlineMs = transitionAtMs + safeRoundMs;
        this.answers.clear();
        this.gameState = "playing";
        transitioned = true;
        continue;
      }

      if (this.gameState === "playing") {
        const startedAtMs = this.roundStartedAtMs ?? Math.max(0, transitionAtMs - safeRoundMs);
        closedRounds.push({
          round: this.currentRound,
          startedAtMs,
          deadlineMs: transitionAtMs,
          answers: new Map(this.answers),
        });
        this.answers.clear();
        this.roundStartedAtMs = null;
        this.roundDeadlineMs = transitionAtMs + safeRevealMs;
        this.gameState = "reveal";
        transitioned = true;
        continue;
      }

      if (this.gameState === "reveal") {
        this.gameState = "leaderboard";
        this.roundDeadlineMs = transitionAtMs + safeLeaderboardMs;
        this.roundStartedAtMs = null;
        transitioned = true;
        continue;
      }

      if (this.gameState === "leaderboard") {
        if (this.currentRound >= this.plannedTotalRounds) {
          this.gameState = "results";
          this.roundDeadlineMs = null;
          this.roundStartedAtMs = null;
          transitioned = true;
          break;
        }

        this.currentRound += 1;
        this.roundStartedAtMs = transitionAtMs;
        this.roundDeadlineMs = transitionAtMs + safeRoundMs;
        this.answers.clear();
        this.gameState = "playing";
        transitioned = true;
        continue;
      }

      break;
    }

    return { transitioned, closedRounds };
  }

  submitAnswer(playerId: string, value: string, submittedAtMs: number) {
    if (this.gameState !== "playing") return { accepted: false as const };
    if (this.roundDeadlineMs !== null && submittedAtMs > this.roundDeadlineMs) {
      return { accepted: false as const };
    }
    if (this.answers.has(playerId)) return { accepted: false as const };
    this.answers.set(playerId, { value, submittedAtMs });
    return { accepted: true as const };
  }
}
