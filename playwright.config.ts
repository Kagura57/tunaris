import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  webServer: [
    {
      command: "PATH=$HOME/.bun/bin:$PATH bun run dev:api",
      url: "http://127.0.0.1:3001/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "PATH=$HOME/.bun/bin:$PATH bun run dev:web",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
});
