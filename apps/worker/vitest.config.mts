import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          MODERATOR_TOKEN: "test-moderator-token",
          TEST_MIGRATIONS: await readD1Migrations(
            fileURLToPath(new URL("./migrations", import.meta.url)),
          ),
        },
      },
    })),
  ],
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
});
