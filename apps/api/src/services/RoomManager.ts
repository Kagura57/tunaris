export type GameState =
  | "waiting"
  | "countdown"
  | "loading"
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
  loadingMs: number;
  roundMs: number;
  revealMs: number;
  leaderboardMs: number;
};

type TickResult = {
  transitioned: boolean;
  closedRounds: ClosedRound[];
};

type SkipPlayingRoundInput = {
  nowMs: number;
  loadingMs: number;
  roundMs: number;
};

type SkipPlayingRoundResult = {
  skipped: boolean;
  closedRound: ClosedRound | null;
};

export class RoomManager {
  private gameState: GameState = "waiting";
  private currentRound = 0;
  private roundDeadlineMs: number | null = null;
  private roundStartedAtMs: number | null = null;
  private plannedTotalRounds = 0;
  private answers = new Map<string, RoundAnswer>();
  private drafts = new Map<string, string>();
  private guessedSkipPlayerIds = new Set<string>();
  private revealSkipPlayerIds = new Set<string>();

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

  setTotalRounds(totalRounds: number) {
    const safeTotal = Math.max(0, totalRounds);
    this.plannedTotalRounds = Math.max(this.currentRound, safeTotal);
  }

  startGame(input: StartGameInput) {
    if (this.gameState !== "waiting") return false;

    const safeCountdownMs = Math.max(0, input.countdownMs);
    this.currentRound = 0;
    this.roundStartedAtMs = null;
    this.answers.clear();
    this.drafts.clear();
    this.guessedSkipPlayerIds.clear();
    this.revealSkipPlayerIds.clear();
    this.plannedTotalRounds = Math.max(0, input.totalRounds);
    this.gameState = "countdown";
    this.roundDeadlineMs = input.nowMs + safeCountdownMs;
    return true;
  }

  skipPlayingRound(input: SkipPlayingRoundInput): SkipPlayingRoundResult {
    if (this.gameState !== "playing" && this.gameState !== "loading") {
      return { skipped: false, closedRound: null };
    }

    const safeLoadingMs = Math.max(0, input.loadingMs);
    const safeRoundMs = Math.max(1, input.roundMs);
    const closedRound: ClosedRound = {
      round: this.currentRound,
      startedAtMs: this.roundStartedAtMs ?? Math.max(0, input.nowMs - safeRoundMs),
      deadlineMs: input.nowMs,
      answers: this.finalizeCurrentRoundAnswers(input.nowMs),
    };

    this.answers.clear();
    this.drafts.clear();
    this.guessedSkipPlayerIds.clear();
    this.revealSkipPlayerIds.clear();

    if (this.currentRound >= this.plannedTotalRounds) {
      this.gameState = "results";
      this.roundStartedAtMs = null;
      this.roundDeadlineMs = null;
      return { skipped: true, closedRound };
    }

    this.currentRound += 1;
    if (safeLoadingMs > 0) {
      this.gameState = "loading";
      this.roundStartedAtMs = input.nowMs;
      this.roundDeadlineMs = null;
    } else {
      this.gameState = "playing";
      this.roundStartedAtMs = input.nowMs;
      this.roundDeadlineMs = input.nowMs + safeRoundMs;
    }
    return { skipped: true, closedRound };
  }

  forcePlayingRound(round: number, deadlineMs: number, startedAtMs?: number) {
    this.answers.clear();
    this.drafts.clear();
    this.guessedSkipPlayerIds.clear();
    this.revealSkipPlayerIds.clear();
    this.currentRound = Math.max(1, round);
    this.roundStartedAtMs =
      startedAtMs !== undefined ? startedAtMs : Math.max(0, deadlineMs - 15_000);
    this.roundDeadlineMs = deadlineMs;
    this.gameState = "playing";
    this.plannedTotalRounds = Math.max(this.plannedTotalRounds, this.currentRound);
  }

  expireCurrentPhase(nowMs: number) {
    if (
      this.gameState !== "countdown" &&
      this.gameState !== "loading" &&
      this.gameState !== "playing" &&
      this.gameState !== "reveal" &&
      this.gameState !== "leaderboard"
    ) {
      return false;
    }
    this.roundDeadlineMs = nowMs;
    return true;
  }

  tick(input: TickInput): TickResult {
    const safeLoadingMs = Math.max(0, input.loadingMs);
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
        this.answers.clear();
        this.drafts.clear();
        this.guessedSkipPlayerIds.clear();
        this.revealSkipPlayerIds.clear();
        if (safeLoadingMs > 0) {
          this.roundStartedAtMs = transitionAtMs;
          this.roundDeadlineMs = null;
          this.gameState = "loading";
        } else {
          this.roundStartedAtMs = transitionAtMs;
          this.roundDeadlineMs = transitionAtMs + safeRoundMs;
          this.gameState = "playing";
        }
        transitioned = true;
        continue;
      }

      if (this.gameState === "loading") {
        this.roundStartedAtMs = transitionAtMs;
        this.roundDeadlineMs = transitionAtMs + safeRoundMs;
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
          answers: this.finalizeCurrentRoundAnswers(transitionAtMs),
        });
        this.answers.clear();
        this.drafts.clear();
        this.guessedSkipPlayerIds.clear();
        this.revealSkipPlayerIds.clear();
        this.roundStartedAtMs = null;
        this.roundDeadlineMs = transitionAtMs + safeRevealMs;
        this.gameState = "reveal";
        transitioned = true;
        continue;
      }

      if (this.gameState === "reveal") {
        this.revealSkipPlayerIds.clear();
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
        this.answers.clear();
        this.drafts.clear();
        this.guessedSkipPlayerIds.clear();
        this.revealSkipPlayerIds.clear();
        if (safeLoadingMs > 0) {
          this.roundStartedAtMs = transitionAtMs;
          this.roundDeadlineMs = null;
          this.gameState = "loading";
        } else {
          this.roundStartedAtMs = transitionAtMs;
          this.roundDeadlineMs = transitionAtMs + safeRoundMs;
          this.gameState = "playing";
        }
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
    if (this.guessedSkipPlayerIds.has(playerId)) return { accepted: false as const };
    if (this.answers.has(playerId)) return { accepted: false as const };
    this.answers.set(playerId, { value, submittedAtMs });
    this.drafts.delete(playerId);
    return { accepted: true as const };
  }

  setDraftAnswer(playerId: string, value: string, submittedAtMs: number) {
    if (this.gameState !== "playing") return { accepted: false as const };
    if (this.roundDeadlineMs !== null && submittedAtMs > this.roundDeadlineMs) {
      return { accepted: false as const };
    }
    if (this.guessedSkipPlayerIds.has(playerId)) return { accepted: false as const };
    if (this.answers.has(playerId)) return { accepted: false as const };
    const trimmed = value.trim();
    if (trimmed.length <= 0) {
      this.drafts.delete(playerId);
      return { accepted: true as const };
    }
    this.drafts.set(playerId, trimmed);
    return { accepted: true as const };
  }

  hasSubmittedAnswer(playerId: string) {
    return this.answers.has(playerId);
  }

  skipGuessForPlayer(playerId: string, nowMs: number) {
    if (this.gameState !== "playing") return { accepted: false as const };
    if (this.roundDeadlineMs !== null && nowMs > this.roundDeadlineMs) {
      return { accepted: false as const };
    }
    if (this.answers.has(playerId)) return { accepted: false as const };
    if (this.guessedSkipPlayerIds.has(playerId)) return { accepted: false as const };
    this.guessedSkipPlayerIds.add(playerId);
    this.drafts.delete(playerId);
    return { accepted: true as const };
  }

  skipRevealForPlayer(playerId: string, nowMs: number) {
    if (this.gameState !== "reveal") return { accepted: false as const };
    if (this.roundDeadlineMs !== null && nowMs > this.roundDeadlineMs) {
      return { accepted: false as const };
    }
    if (this.revealSkipPlayerIds.has(playerId)) return { accepted: false as const };
    this.revealSkipPlayerIds.add(playerId);
    return { accepted: true as const };
  }

  hasGuessSkipped(playerId: string) {
    return this.guessedSkipPlayerIds.has(playerId);
  }

  hasGuessDone(playerId: string) {
    return this.answers.has(playerId) || this.guessedSkipPlayerIds.has(playerId);
  }

  hasRevealSkipped(playerId: string) {
    return this.revealSkipPlayerIds.has(playerId);
  }

  answeredPlayerIds() {
    return [...this.answers.keys()];
  }

  resetToWaiting() {
    this.gameState = "waiting";
    this.currentRound = 0;
    this.roundDeadlineMs = null;
    this.roundStartedAtMs = null;
    this.plannedTotalRounds = 0;
    this.answers.clear();
    this.drafts.clear();
    this.guessedSkipPlayerIds.clear();
    this.revealSkipPlayerIds.clear();
  }

  private finalizeCurrentRoundAnswers(deadlineMs: number) {
    const merged = new Map(this.answers);
    for (const [playerId, value] of this.drafts.entries()) {
      if (merged.has(playerId)) continue;
      if (this.guessedSkipPlayerIds.has(playerId)) continue;
      const trimmed = value.trim();
      if (trimmed.length <= 0) continue;
      merged.set(playerId, {
        value: trimmed,
        submittedAtMs: deadlineMs,
      });
    }
    return merged;
  }
}
