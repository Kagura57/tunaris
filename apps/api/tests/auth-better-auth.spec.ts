import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("better-auth integration", () => {
  it("exposes authenticated me endpoint", async () => {
    const response = await app.handle(new Request("http://localhost/account/me"));
    expect(response.status).toBe(401);
  });
});
