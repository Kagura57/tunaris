import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("auth routes", () => {
  it("mounts better-auth endpoints under /auth", async () => {
    const response = await app.handle(new Request("http://localhost/auth/get-session"));
    expect(response.status).not.toBe(404);
  });

  it("returns unauthorized on /account/me without session cookie", async () => {
    const response = await app.handle(new Request("http://localhost/account/me"));
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("UNAUTHORIZED");
  });
});
