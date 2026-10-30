import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, git, root } from "../repository";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("commit hookのGit環境変数を一時repoへ引き継がない", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ci-git-env-"));
  directories.push(cwd);
  const result = Bun.spawnSync(
    [
      "bun",
      "-e",
      `import {git} from ${JSON.stringify(join(root, "scripts/ci/repository.ts"))}; git(["init", "-q"], process.argv[1]); console.log(git(["rev-parse", "--show-toplevel"], process.argv[1]).trim());`,
      cwd,
    ],
    {
      env: {
        ...process.env,
        GIT_DIR: join(cwd, "wrong.git"),
        GIT_WORK_TREE: join(cwd, "wrong-tree"),
        GIT_INDEX_FILE: join(cwd, "wrong-index"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode).toBe(0);
  // macOSの/tmpは/private/tmpへ正規化されます。
  expect(result.stdout.toString().trim()).toBe(git(["rev-parse", "--show-toplevel"], cwd).trim());
});

test("実git差分はrename元・削除・空白を含むパスとbase更新を取り込む", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ci-diff-"));
  directories.push(cwd);
  git(["init", "-q"], cwd);
  git(["config", "user.email", "ci@example.invalid"], cwd);
  git(["config", "user.name", "CI test"], cwd);
  git(["config", "commit.gpgsign", "false"], cwd);
  writeFileSync(join(cwd, "old name.ts"), "export const a = 1;\n");
  writeFileSync(join(cwd, "deleted.ts"), "export const b = 1;\n");
  git(["add", "."], cwd);
  git(["commit", "-qm", "base"], cwd);
  const base = git(["rev-parse", "HEAD"], cwd).trim();
  git(["mv", "old name.ts", "new name.ts"], cwd);
  git(["rm", "deleted.ts"], cwd);
  git(["commit", "-qm", "head"], cwd);
  expect(changedFiles(base, "HEAD", cwd).sort()).toEqual([
    "deleted.ts",
    "new name.ts",
    "old name.ts",
  ]);
  expect(() => changedFiles("missing", "HEAD", cwd)).toThrow();
  expect(() => changedFiles("0".repeat(40), "HEAD", cwd)).toThrow();
});
