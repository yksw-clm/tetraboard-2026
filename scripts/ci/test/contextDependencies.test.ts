import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkContextDependencies } from "../../checkContextDependencies";
import { root } from "../repository";

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function repository(): string {
  const fixture = mkdtempSync(resolve(root, ".context-dependencies-test-"));
  fixtures.push(fixture);
  return fixture;
}

function context(
  fixture: string,
  name: string,
  source = "export {};",
  dependencies: Record<string, string> = {},
  devDependencies: Record<string, string> = {},
): string {
  const directory = resolve(fixture, "packages/contexts", name);
  mkdirSync(resolve(directory, "src"), { recursive: true });
  writeFileSync(resolve(directory, "src/index.ts"), source);
  writeFileSync(
    resolve(directory, "package.json"),
    JSON.stringify({ name: `@tetraboard/context-${name}`, dependencies, devDependencies }, null, 2),
  );
  return directory;
}

function check(source: string, name = "room") {
  const fixture = repository();
  context(fixture, name, source);
  return checkContextDependencies(fixture);
}

const forbiddenImports = [
  "cloudflare:workers",
  "cloudflare:sockets",
  "@cloudflare/workers-types",
  "@cloudflare/vitest-pool-workers/config",
  "zod",
  "zod/v4",
  "drizzle-orm",
  "drizzle-orm/sqlite-core",
  "hono",
  "hono/utils/http-status",
  "better-auth",
  "better-auth/api",
  "@tetraboard/context-account",
  "@tetraboard/context-account/domain",
  "../../shared/src/index",
];

const importForms = [
  (specifier: string) => `import { value } from "${specifier}";`,
  (specifier: string) => `import type { Value } from "${specifier}";`,
  (specifier: string) => `import "${specifier}";`,
  (specifier: string) => `export { value } from "${specifier}";`,
  (specifier: string) => `export type { Value } from "${specifier}";`,
  (specifier: string) => `export * from "${specifier}";`,
  (specifier: string) => `async function load() { return import("${specifier}"); }`,
  (specifier: string) => `import value = require("${specifier}");`,
  (specifier: string) => `type Value = import("${specifier}").Value;`,
];

for (const [index, form] of importForms.entries()) {
  test.each(forbiddenImports)(
    `禁止対象を構文 ${index + 1} で参照すると失敗する: %s`,
    (specifier) => {
      const diagnostics = check(form(specifier));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].line).toBe(1);
      expect(diagnostics[0].reason).toContain(specifier);
    },
  );
}

test.each([
  'import type { Value } from "@tetraboard/protocol";',
  'import type Value from "@tetraboard/protocol";',
  'import type * as Protocol from "@tetraboard/protocol";',
  'import { type Value, type Other as Alias } from "@tetraboard/protocol";',
  'export type { Value } from "@tetraboard/protocol";',
  'export type * from "@tetraboard/protocol";',
  'export type * as Protocol from "@tetraboard/protocol";',
  'export { type Value, type Other } from "@tetraboard/protocol";',
  'type Value = import("@tetraboard/protocol").Value;',
  'import type Protocol = require("@tetraboard/protocol");',
  'import type { Value } from "@tetraboard/protocol/types";',
])("protocol の型だけの参照は許す: %s", (source) => {
  expect(check(source)).toEqual([]);
});

test.each([
  'import { value } from "@tetraboard/protocol";',
  'import { type Value, value } from "@tetraboard/protocol";',
  'import value, { type Value } from "@tetraboard/protocol";',
  'import * as Protocol from "@tetraboard/protocol";',
  'import "@tetraboard/protocol";',
  'import {} from "@tetraboard/protocol";',
  'export { value } from "@tetraboard/protocol";',
  'export { type Value, value } from "@tetraboard/protocol";',
  'export {} from "@tetraboard/protocol";',
  'export * from "@tetraboard/protocol";',
  'export * as Protocol from "@tetraboard/protocol";',
  'const protocol = import("@tetraboard/protocol");',
  "const protocol = import(`@tetraboard/protocol`);",
  'import Protocol = require("@tetraboard/protocol");',
  'import { value } from "@tetraboard/protocol/types";',
])("protocol の値の参照が 1 つでもあれば失敗する: %s", (source) => {
  const diagnostics = check(source);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0].reason).toContain("import type");
});

test.each(["import(path);", 'import("zo" + "d");', "import(`./${name}`);"])(
  "検査できない動的 import を見逃さない: %s",
  (source) => {
    expect(check(source)[0].reason).toContain("文字列リテラル");
  },
);

test("コメントや文字列は import と数えず、複数行・エスケープ済み文字列は解析する", () => {
  expect(
    check(
      [
        '// import "zod";',
        '/* export * from "hono"; */',
        "const text = 'import(\"drizzle-orm\")';",
        'const template = `import "cloudflare:workers";`;',
      ].join("\n"),
    ),
  ).toEqual([]);
  const diagnostics = check(
    [
      "// head",
      "import {",
      "  value,",
      '} from "z\\u006fd";',
      'export /* comment */ * from "hono";',
      'const load = () => import /* comment */ ("better-auth");',
    ].join("\n"),
  );
  expect(diagnostics.map(({ line }) => line)).toEqual([2, 5, 6]);
  expect(diagnostics.map(({ reason }) => reason)).toEqual([
    "文脈で禁止された import です: zod",
    "文脈で禁止された import です: hono",
    "文脈で禁止された import です: better-auth",
  ]);
});

test.each([
  "@tetraboard/context-room",
  "@tetraboard/context-room/domain",
  "@tetraboard/context-shared",
  "@tetraboard/context-shared/domain",
  "@tetraboard/game-contract",
  "@tetraboard/gomoku",
  "./domain",
  "./domain/../use-cases",
  "../package.json",
  "../src/domain",
  "zod-like",
  "node:path",
])("自分・shared・純粋な依存・パッケージ内の相対参照は許す: %s", (specifier) => {
  for (const form of importForms) expect(check(form(specifier))).toEqual([]);
});

test("shared はほかの文脈を参照できず、自分は参照できる", () => {
  expect(check('import type { Value } from "@tetraboard/context-room";', "shared")).toHaveLength(1);
  expect(check('import type { Value } from "@tetraboard/context-shared";', "shared")).toEqual([]);
});

test.each(["index.ts", "nested/file.ts", "view.tsx", "module.mts", "module.cts", "types.d.ts"])(
  "src の TypeScript 全体を調べる: %s",
  (filename) => {
    const fixture = repository();
    const directory = context(fixture, "room");
    const file = resolve(directory, "src", filename);
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, 'import "zod";');
    expect(checkContextDependencies(fixture)).toEqual([
      { file, line: 1, reason: "文脈で禁止された import です: zod" },
    ]);
  },
);

test("パッケージ外への判定はネストと紛らわしいディレクトリ名を考慮する", () => {
  const fixture = repository();
  const directory = context(fixture, "room");
  mkdirSync(resolve(directory, "src/domain"));
  writeFileSync(
    resolve(directory, "src/domain/index.ts"),
    [
      'import "../use-cases";',
      'import "../../package.json";',
      'import "../../../room-other/src";',
      'import "../../../room/src/index";',
    ].join("\n"),
  );
  const diagnostics = checkContextDependencies(fixture);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0].line).toBe(3);
});

test("src の外と TypeScript 以外のファイルは対象にしない", () => {
  const fixture = repository();
  const directory = context(fixture, "room");
  mkdirSync(resolve(directory, "test"));
  writeFileSync(resolve(directory, "test/index.test.ts"), 'import "zod";');
  writeFileSync(resolve(directory, "src/fixture.txt"), 'import "zod";');
  expect(checkContextDependencies(fixture)).toEqual([]);
});

const allowedDependencies = [
  "@tetraboard/context-shared",
  "@tetraboard/game-contract",
  "@tetraboard/reversi",
  "@tetraboard/four-reversi",
  "@tetraboard/gomoku",
  "@tetraboard/four-gomoku",
  "@tetraboard/shogi",
  "@tetraboard/four-shogi",
  "@tetraboard/protocol",
  "typescript",
  "@types/bun",
];

test.each(["dependencies", "devDependencies"])("%s の許可リストを検査する", (group) => {
  const fixture = repository();
  const dependencies = Object.fromEntries(allowedDependencies.map((name) => [name, "*"]));
  const directory = context(
    fixture,
    "room",
    "",
    group === "dependencies" ? dependencies : {},
    group === "devDependencies" ? dependencies : {},
  );
  expect(checkContextDependencies(fixture)).toEqual([]);
  writeFileSync(
    resolve(directory, "package.json"),
    [
      "{",
      '  "name": "@tetraboard/context-room",',
      `  "${group}": {`,
      '    "@tetraboard/ai": "workspace:*",',
      '    "@tetraboard/context-account": "workspace:*",',
      '    "@tetraboard/context-room": "workspace:*"',
      "  }",
      "}",
    ].join("\n"),
  );
  const diagnostics = checkContextDependencies(fixture);
  expect(diagnostics.map(({ line }) => line)).toEqual([4, 5, 6]);
  for (const diagnostic of diagnostics) {
    expect(diagnostic.file).toBe(resolve(directory, "package.json"));
    expect(diagnostic.reason).toContain(group);
  }
});

test.each(["dependencies", "devDependencies"])("shared の %s は文脈に依存しない", (group) => {
  const fixture = repository();
  const dependencies = { "@tetraboard/context-room": "*", "@tetraboard/context-shared": "*" };
  context(
    fixture,
    "shared",
    "",
    group === "dependencies" ? dependencies : {},
    group === "devDependencies" ? dependencies : {},
  );
  const diagnostics = checkContextDependencies(fixture);
  expect(diagnostics).toHaveLength(2);
  for (const diagnostic of diagnostics) expect(diagnostic.reason).toContain("文脈に依存できません");
});

test("shared もゲーム・ゲーム契約・protocol へ依存できる", () => {
  const fixture = repository();
  context(
    fixture,
    "shared",
    "",
    { "@tetraboard/gomoku": "*", "@tetraboard/protocol": "*" },
    { "@tetraboard/game-contract": "*" },
  );
  expect(checkContextDependencies(fixture)).toEqual([]);
});

test("全パッケージの違反をまとめて返す", () => {
  const fixture = repository();
  context(fixture, "room", 'import "zod";');
  context(fixture, "account", 'export * from "hono";');
  expect(checkContextDependencies(fixture)).toHaveLength(2);
});
