import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: {
          PUBLIC_MATCH_TEST_DB: "public-match-tests",
          BADGE_MIGRATION_TEST_DB: "badge-migration-tests",
          ROOM_INDEX_TEST_DB: "room-index-tests",
        },
        bindings: {
          MODERATOR_TOKEN: "test-moderator-token",
          BETTER_AUTH_SECRET: "tetraboard-local-only-secret-at-least-32-characters",
          GOOGLE_CLIENT_ID: "test-google",
          GOOGLE_CLIENT_SECRET: "test-google-secret",
          DISCORD_CLIENT_ID: "test-discord",
          DISCORD_CLIENT_SECRET: "test-discord-secret",
          TEST_MIGRATIONS: await readD1Migrations(
            fileURLToPath(new URL("./migrations", import.meta.url)),
          ),
        },
      },
    })),
  ],
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
});
