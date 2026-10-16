import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flattenDiagnosticMessageText, parseConfigFileTextToJson } from "typescript";
import { defineConfig } from "vitest/config";

// JSONCの実行条件だけを読み、Wranglerの個人設定ローダーを通しません。
const configPath = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
const { config, error } = parseConfigFileTextToJson(configPath, readFileSync(configPath, "utf8"));
if (error) throw new Error(flattenDiagnosticMessageText(error.messageText, "\n"));

export function workerTestConfig(extraBindings: Record<string, string> = {}) {
  return defineConfig({
    plugins: [
      cloudflareTest(async () => ({
        main: config.main,
        remoteBindings: false,
        miniflare: {
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          durableObjects: { GAME_ROOM: { className: "GameRoom", useSQLite: true } },
          r2Buckets: ["OBJECT_STORAGE"],
          d1Databases: {
            APP_DB: "app-tests",
            LOBBY_TEST_DB: "lobby-tests",
            MATCH_COMPATIBILITY_TEST_DB: "match-compatibility-tests",
            PUBLIC_MATCH_TEST_DB: "public-match-tests",
            BADGE_MIGRATION_TEST_DB: "badge-migration-tests",
            ROOM_INDEX_TEST_DB: "room-index-tests",
          },
          bindings: {
            APP_ORIGIN: "http://localhost:5173",
            MODERATOR_TOKEN: "test-moderator-token",
            FEEDBACK_HASH_SECRET: "feedback-test-only-secret-at-least-32-characters",
            BETTER_AUTH_SECRET: "tetraboard-local-only-secret-at-least-32-characters",
            GOOGLE_CLIENT_ID: "test-google",
            GOOGLE_CLIENT_SECRET: "test-google-secret",
            DISCORD_CLIENT_ID: "test-discord",
            DISCORD_CLIENT_SECRET: "test-discord-secret",
            ...extraBindings,
            TEST_MIGRATIONS: await readD1Migrations(
              fileURLToPath(new URL("./migrations", import.meta.url)),
            ),
          },
        },
      })),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
  });
}
export default workerTestConfig();
