import { expect, test } from "bun:test";
import { readPublicMatchMetadata } from "../src";
import { MemoryReadStore } from "./memoryReadStore";
import { matches, stored, decode } from "./readFixtures";

for (const original of matches) {
  test(`${original.game}: メタ情報は公開済み本体だけを読み、IDとゲーム以外を返さない`, async () => {
    const store = new MemoryReadStore();
    store.records.push(stored(original).match);
    // チャンクやプロフィールが利用できなくても、固定カードに必要な情報は取得できます。
    const result = await readPublicMatchMetadata(store, original.record.id, decode);
    expect(result).toEqual({ id: original.record.id, game: original.game });
    expect(store.calls).toEqual(["match"]);
  });
}

test("公開済み本体がなければメタ情報はなく、保存形式の検証失敗は呼出元へ返す", async () => {
  const store = new MemoryReadStore();
  expect(await readPublicMatchMetadata(store, "missing", decode)).toBeNull();
  const original = stored(matches[0]!).match;
  const row = { game: original.game, record_json: JSON.stringify(original.record) };
  await expect(
    readPublicMatchMetadata({ readMatch: async () => row }, "different-id", decode),
  ).rejects.toThrow("Stored match ID mismatch");
  await expect(
    readPublicMatchMetadata(
      { readMatch: async () => ({ ...row, game: "unknown" }) },
      original.record.id,
      decode,
    ),
  ).rejects.toThrow("Stored match game mismatch");
  await expect(
    readPublicMatchMetadata(
      { readMatch: async () => ({ ...row, record_json: "{" }) },
      original.record.id,
      decode,
    ),
  ).rejects.toThrow();
});
