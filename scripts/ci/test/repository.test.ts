import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readWorkspaces, root } from "../repository";

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

test("直下の workspace と文脈を列挙し、contexts 自体と通常ファイルを数えない", () => {
  const fixture = mkdtempSync(resolve(root, ".repository-test-"));
  fixtures.push(fixture);
  for (const path of [
    "apps/web",
    "packages/gomoku",
    "packages/contexts/room",
    "packages/contexts/shared",
  ])
    mkdirSync(resolve(fixture, path), { recursive: true });
  for (const path of ["apps/README.md", "packages/README.md", "packages/contexts/README.md"])
    writeFileSync(resolve(fixture, path), "");

  expect(readWorkspaces(fixture)).toEqual([
    "apps/web",
    "packages/contexts/room",
    "packages/contexts/shared",
    "packages/gomoku",
  ]);
});

test("contexts がないリポジトリでも既存の workspace を列挙する", () => {
  const fixture = mkdtempSync(resolve(root, ".repository-test-"));
  fixtures.push(fixture);
  mkdirSync(resolve(fixture, "apps/worker"), { recursive: true });
  mkdirSync(resolve(fixture, "packages/gomoku"), { recursive: true });
  expect(readWorkspaces(fixture)).toEqual(["apps/worker", "packages/gomoku"]);
});

test("9 文脈が CI の workspace に含まれ、型検査とテストの入口を持つ", async () => {
  const contexts = readWorkspaces().filter((path) => path.startsWith("packages/contexts/"));
  expect(contexts).toEqual(
    [
      "account",
      "community",
      "matchmaking",
      "privacy",
      "rating",
      "record",
      "room",
      "shared",
      "tournament",
    ].map((name) => `packages/contexts/${name}`),
  );
  expect(readWorkspaces()).not.toContain("packages/contexts");
  for (const context of contexts) {
    const manifest = await Bun.file(resolve(root, context, "package.json")).json();
    expect(manifest.scripts.typecheck).toBe(
      "bun ../../../scripts/checkBunVersion.ts && bun check --no-script --all",
    );
    expect(manifest.scripts.test).toBe("bun test");
  }
});
