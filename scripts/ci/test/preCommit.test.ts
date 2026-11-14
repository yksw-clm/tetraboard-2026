import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { selectFiles } from "../../preCommit";

const { ignorePatterns } = JSON.parse(
  readFileSync(new URL("../../../.oxfmtrc.json", import.meta.url), "utf8"),
);

test("ステージしたファイルがなければformatとlintの対象は空です", () => {
  expect(selectFiles([], ignorePatterns)).toEqual({ format: [], lint: [] });
});

test("oxlintが扱う拡張子だけをlintへ振り分けます", () => {
  const lint = [
    "file.js",
    "file.jsx",
    "file.mjs",
    "file.cjs",
    "file.ts",
    "file.tsx",
    "file.mts",
    "file.cts",
    "file.vue",
    "file.svelte",
    "file.astro",
  ];
  const files = [...lint, "package.json", "style.css", "note.md", "image.png"];
  expect(selectFiles(files, [])).toEqual({ format: files, lint });
});

test("既存のignorePatternsに一致するファイルをformatから除外します", () => {
  const ignored = [
    "README.md",
    "docs/guide.md",
    "docs/nested/guide.md",
    "apps/web/README.md",
    "worker-configuration.d.ts",
    "apps/worker/worker-configuration.d.ts",
  ];
  expect(selectFiles(ignored, ignorePatterns)).toEqual({
    format: [],
    lint: ["worker-configuration.d.ts", "apps/worker/worker-configuration.d.ts"],
  });
  expect(selectFiles(["README.md"], ignorePatterns)).toEqual({ format: [], lint: [] });
});

test("除外パターンは設定を入力として受け取ります", () => {
  expect(selectFiles(["custom/file.ts", "file.ts"], ["custom/**"])).toEqual({
    format: ["file.ts"],
    lint: ["custom/file.ts", "file.ts"],
  });
});

test("空白や改行を含むファイル名を変えずに保持し、入力を変更しません", () => {
  const files = Object.freeze(["space name.ts", "line\nbreak.ts", "notes/read me.md"]);
  expect(selectFiles(files, ignorePatterns)).toEqual({
    format: ["space name.ts", "line\nbreak.ts", "notes/read me.md"],
    lint: ["space name.ts", "line\nbreak.ts"],
  });
});
