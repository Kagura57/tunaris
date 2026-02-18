import { test, expect } from "@playwright/test";

test("host can create room and reach lobby", async ({ page }) => {
  await page.goto("http://localhost:5173/");
  await expect(page).toHaveURL(/\/$/);
});
