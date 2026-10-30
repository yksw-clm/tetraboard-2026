import { expect, test } from "bun:test";
import { splitWorkerFiles, workerTestPattern } from "../workerGroups";
import { root } from "../repository";
import { statSync } from "node:fs";

test("全Workerファイルを重複も欠落もなく分割し、大きな2ファイルを別の実行へ入れる", () => {
  const files = [...new Bun.Glob(workerTestPattern).scanSync(`${root}/apps/worker`)].map(
    (path) => ({ path, size: statSync(`${root}/apps/worker/${path}`).size }),
  );
  const groups = splitWorkerFiles(files);
  expect(groups).toHaveLength(2);
  expect(groups.flat().sort()).toEqual(files.map((file) => file.path).sort());
  expect(splitWorkerFiles(files.toReversed())).toEqual(groups);
  const largest = files.toSorted((a, b) => b.size - a.size);
  expect(groups.find((group) => group.includes(largest[0].path))).not.toContain(largest[1].path);
});

test("新規・同サイズ・1ファイルでも失われず、空グループで全スイートを再実行しない", () => {
  expect(splitWorkerFiles([])).toEqual([]);
  expect(splitWorkerFiles([{ path: "test/new.test.ts", size: 1 }])).toEqual([["test/new.test.ts"]]);
  expect(
    splitWorkerFiles(["a", "b", "c"].map((path) => ({ path, size: 100 })))
      .flat()
      .sort(),
  ).toEqual(["a", "b", "c"]);
});
