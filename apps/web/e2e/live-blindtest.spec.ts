import { expect, test } from "@playwright/test";

test("live blindtest flow supports play + projection view", async ({ page, context }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Créer et jouer" }).click();
  await expect(page).toHaveURL(/\/room\/[A-Z2-9]{6}\/play/);

  const roomCode = page.url().split("/room/")[1]?.split("/")[0] ?? "";
  expect(roomCode).toMatch(/^[A-Z2-9]{6}$/);

  await page.getByRole("button", { name: /Démarrer le blindtest/i }).click();
  await expect(page.getByText(/Manche/i)).toBeVisible();

  const projection = await context.newPage();
  await projection.goto(`/room/${roomCode}/view`);
  await expect(projection.getByText(roomCode)).toBeVisible();

  await projection.close();
});
