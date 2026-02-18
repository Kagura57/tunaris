import { describe, expect, it } from "vitest";
import { GAME_STATES } from "./constants";

describe("shared contracts", () => {
  it("includes required room states", () => {
    expect(GAME_STATES).toContain("waiting");
    expect(GAME_STATES).toContain("results");
  });
});
