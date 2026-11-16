import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("../", import.meta.url));
function fixture(failing: boolean) {
  const root = mkdtempSync(join(worker, ".migration generator's-test-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "drizzle"));
  mkdirSync(join(root, "migrations"));
  cpSync(join(worker, "scripts/generateMigration.ts"), join(root, "scripts/generateMigration.ts"));
  cpSync(join(worker, "drizzle/meta"), join(root, "drizzle/meta"), { recursive: true });
  writeFileSync(
    join(root, "schema.ts"),
    failing
      ? 'throw new Error("SCHEMA_LOAD_FAILURE");\n'
      : `export * from ${JSON.stringify(join(worker, "src/db/schema/index.ts"))};\n`,
  );
  writeFileSync(
    join(root, "drizzle.config.ts"),
    `import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./schema.ts", out: "./drizzle" });\n`,
  );
  return root;
}
function run(root: string, terminal: boolean) {
  const command = [process.execPath, join(root, "scripts/generateMigration.ts"), "review_test"];
  const args =
    process.platform === "darwin"
      ? ["-q", join(root, "terminal.log"), ...command]
      : [
          "-q",
          "-e",
          "-c",
          command.map((arg) => "'" + arg.replaceAll("'", "'\"'\"'") + "'").join(" "),
          join(root, "terminal.log"),
        ];
  return spawnSync(terminal ? "script" : command[0], terminal ? args : command.slice(1), {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
for (const terminal of [false, true]) {
  for (const failing of [false, true]) {
    test(`${terminal ? "対話" : "非対話"}: ${failing ? "schema読込み例外を成功と報告しない" : "変更なしを出力とjournalの両方で確認する"}`, () => {
      const root = fixture(failing);
      try {
        const journal = readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8");
        const result = run(root, terminal);
        const output = result.stdout + result.stderr;
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(failing ? 1 : 0);
        if (failing) {
          expect(output).toContain("SCHEMA_LOAD_FAILURE");
          expect(output).not.toContain("変更なし: migrationsには何も追加しませんでした。");
        } else {
          expect(output).toContain("No schema changes");
          expect(output).toContain("変更なし: migrationsには何も追加しませんでした。");
        }
        expect(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8")).toBe(journal);
        expect(readdirSync(join(root, "migrations"))).toEqual([]);
        expect(readdirSync(join(root, "drizzle"))).toEqual(["meta"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
