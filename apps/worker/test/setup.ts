import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";
import { trackDurableObjects } from "./durableObjectCleanup";

beforeEach(trackDurableObjects);

beforeAll(async () => {
  const migrations = (
    env as typeof env & {
      TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
    }
  ).TEST_MIGRATIONS;
  await applyD1Migrations(env.APP_DB, migrations);
});
