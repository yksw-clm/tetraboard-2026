import { expect, test } from "bun:test";
import { readStudyCacheEnvironment } from "../src/server/searchSettings";

test("探索キャッシュは明示した場合だけ上書きする", () => {
  expect(readStudyCacheEnvironment({})).toBeUndefined();
  for (const count of [0, 1024, 65536])
    expect(readStudyCacheEnvironment({ STUDY_SEARCH_CACHE_ENTRIES: String(count) })).toBe(count);
});

test("不正な探索キャッシュ設定を起動前に拒否する", () => {
  for (const raw of ["", " ", "-1", "1.5", "65537", "NaN", "Infinity"])
    expect(() => readStudyCacheEnvironment({ STUDY_SEARCH_CACHE_ENTRIES: raw })).toThrow(
      "STUDY_SEARCH_CACHE_ENTRIES",
    );
});
