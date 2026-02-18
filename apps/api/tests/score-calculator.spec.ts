import { describe, expect, it } from "vitest";
import { applyScore } from "../src/services/ScoreCalculator";

describe("ScoreCalculator", () => {
  it("increases multiplier on consecutive correct answers", () => {
    const a = applyScore({ isCorrect: true, responseMs: 1800, streak: 0, baseScore: 1000 });
    const b = applyScore({
      isCorrect: true,
      responseMs: 1700,
      streak: a.nextStreak,
      baseScore: 1000,
    });
    expect(a.multiplier).toBe(1);
    expect(b.multiplier).toBeGreaterThan(a.multiplier);
  });

  it("resets streak on timeout", () => {
    const result = applyScore({ isCorrect: false, responseMs: 15000, streak: 3, baseScore: 1000 });
    expect(result.nextStreak).toBe(0);
  });
});
