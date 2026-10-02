import { defineConfig } from "@playwright/test";
import browserConfig from "./playwright.config";

// 本番と同じビルドをローカルWorkerにつなぎます。外部APIの差し替えは行いません。
export default defineConfig({
  ...browserConfig,
  testMatch: "worker.e2e.ts",
  workers: 1,
  timeout: 60_000,
  outputDir: "test-results-worker",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-worker" }]],
  projects: [{ name: "chromium-worker", use: { browserName: "chromium" } }],
  use: {
    ...browserConfig.use,
    baseURL: "http://127.0.0.1:8788",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command:
      "bun run --cwd ../worker db:migrate:preview && bun run --cwd ../worker preview:production",
    url: "http://127.0.0.1:8788/api/healthz",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
