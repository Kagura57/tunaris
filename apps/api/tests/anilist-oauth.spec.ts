import { describe, expect, it } from "vitest";
import { buildAniListConnectUrl } from "../src/services/AniListOAuthService";

describe("anilist oauth", () => {
  it("builds authorize url with state", () => {
    process.env.ANILIST_CLIENT_ID = "demo-client";
    process.env.ANILIST_REDIRECT_URI = "http://127.0.0.1:3001/account/anilist/connect/callback";

    const result = buildAniListConnectUrl({ userId: "u_1", returnTo: "/settings" });
    expect(result?.url).toContain("https://anilist.co/api/v2/oauth/authorize");
    expect(result?.url).toContain("state=");
  });
});
