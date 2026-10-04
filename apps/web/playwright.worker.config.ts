import { defineConfig } from "@playwright/test";
import browserConfig from "./playwright.config";

// 本番と同じビルドをローカルWorkerにつなぎます。外部APIの差し替えは行いません。
export default defineConfig({
  ...browserConfig,
  testMatch: ["worker.e2e.ts", "seo.worker.e2e.ts"],
  workers: 1,
  timeout: 60_000,
  outputDir: "test-results-worker",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-worker" }]],
  projects: [
    { name: "chromium-worker", use: { browserName: "chromium" } },
    { name: "webkit-worker", use: { browserName: "webkit" } },
  ],
  use: {
    ...browserConfig.use,
    baseURL: "http://127.0.0.1:8788",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command:
      "bun run --cwd ../worker db:migrate:preview && bunx wrangler d1 execute APP_DB --config ../worker/wrangler.jsonc --env production --local --persist-to ../worker/.wrangler/production-preview --file browser-tests/adminWorkerFixtures.sql && bun run --cwd ../worker preview:production --var ADMIN_ACCOUNT_ID:browser-test-admin --var BETTER_AUTH_SECRET:local-worker-browser-test-only-secret",
    url: "http://127.0.0.1:8788/api/healthz",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
