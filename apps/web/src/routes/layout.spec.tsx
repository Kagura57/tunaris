import { describe, expect, it } from "vitest";
import { router } from "../router";

describe("router layout", () => {
  it("includes projection and player room routes", () => {
    const routeIds = router.routeTree.children?.map((route) => route.id) ?? [];
    expect(routeIds.join("|")).toContain("/room/$roomCode/play");
    expect(routeIds.join("|")).toContain("/room/$roomCode/view");
  });
});
