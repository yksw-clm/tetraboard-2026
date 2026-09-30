import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
  const migrations = (
    env as typeof env & {
      TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
    }
  ).TEST_MIGRATIONS;
  await applyD1Migrations(env.LOBBY_DB, migrations);
});
