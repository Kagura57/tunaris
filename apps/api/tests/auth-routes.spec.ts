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

  it("mounts email auth endpoints for sign-up/sign-in/sign-out", async () => {
    const signUpResponse = await app.handle(
      new Request("http://localhost/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3001",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(signUpResponse.status).not.toBe(404);

    const signInResponse = await app.handle(
      new Request("http://localhost/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3001",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(signInResponse.status).not.toBe(404);

    const signOutResponse = await app.handle(
      new Request("http://localhost/auth/sign-out", {
        method: "POST",
        headers: {
          origin: "http://localhost:3001",
        },
      }),
    );
    expect(signOutResponse.status).not.toBe(404);
  });
});
