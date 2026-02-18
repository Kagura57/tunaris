import { test, expect } from "@playwright/test";

test("host can create room and reach lobby", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tunaris" })).toBeVisible();
  await page.getByRole("button", { name: "Créer une room" }).click();
  await expect(page.getByText(/Room créée/)).toBeVisible();
  await expect(page.getByText(/[A-Z2-9]{6}/)).toBeVisible();
});
