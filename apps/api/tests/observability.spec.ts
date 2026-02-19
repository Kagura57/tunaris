import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("observability routes", () => {
  it("echoes request id header", async () => {
    const response = await app.handle(
      new Request("http://localhost/health", {
        headers: {
          "x-request-id": "req-test-123",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req-test-123");
  });

  it("exposes health details snapshot", async () => {
    const response = await app.handle(new Request("http://localhost/health/details"));
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      service: string;
      rooms: { roomCount: number };
      trackCache: { entryCount: number };
      providers: Record<string, unknown>;
    };

    expect(payload.ok).toBe(true);
    expect(payload.service).toBe("tunaris-api");
    expect(typeof payload.rooms.roomCount).toBe("number");
    expect(typeof payload.trackCache.entryCount).toBe("number");
    expect(typeof payload.providers).toBe("object");
  });

  it("exposes health details on /api alias", async () => {
    const response = await app.handle(new Request("http://localhost/api/health/details"));
    expect(response.status).toBe(200);
  });
});
