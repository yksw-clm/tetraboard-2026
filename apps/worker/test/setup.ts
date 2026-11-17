import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";
import { trackDurableObjects } from "./durableObjectCleanup";
import { cleanupSharedDatabase } from "./sharedDatabaseCleanup";
import { trackWorkerExecutions } from "./workerExecutionCleanup";

beforeEach(({ task }) => {
  const finishWorker = trackWorkerExecutions();
  const dispose = trackDurableObjects(`${task.file.filepath} > ${task.name}`);
  return async () => {
    try {
      await finishWorker();
    } finally {
      await dispose();
    }
    await cleanupSharedDatabase();
  };
});

beforeAll(async () => {
  const migrations = (
    env as typeof env & {
      TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
    }
  ).TEST_MIGRATIONS;
  await applyD1Migrations(env.APP_DB, migrations);
});
