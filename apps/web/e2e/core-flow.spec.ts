import { expect, test } from "@playwright/test";

test("player can create room and reach live play screen", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Créer et jouer" }).click();
  await expect(page).toHaveURL(/\/room\/[A-Z2-9]{6}\/play/);
  await expect(page.getByRole("button", { name: /Démarrer le blindtest/i })).toBeVisible();
});
