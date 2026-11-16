import { expect, test } from "bun:test";
import {
  prepareSnapshotMatch,
  encodeSnapshotMatch,
  type SnapshotSaveValidation,
  type UploadRecord,
} from "../src";
import { MemoryRecordStore, normalize } from "./memoryPorts";

const record = {
  id: "snapshot",
  settings: { game: "gomoku" },
  game: { value: 200 },
  replay: {
    id: "replay",
    initial: { value: 0 },
    steps: Array.from({ length: 201 }, (_, value) => ({
      action: { value },
      game: { value },
    })),
  },
};
const validation: SnapshotSaveValidation<typeof record, UploadRecord, unknown> = {
  readStored: (json) => JSON.parse(json) as UploadRecord,
  encode: (record) => {
    const encoded = encodeSnapshotMatch(record);
    return { ...encoded, canonical: encoded.record };
  },
  parse: (event) => event,
  normalize,
};

test("4ゲームの保存はmanifest、全チャンクの転送と照合を済ませて公開の書き込みを返す", async () => {
  const store = new MemoryRecordStore();
  const result = await prepareSnapshotMatch(store, record, validation);
  const expected = encodeSnapshotMatch(record);
  expect(result.canonical).toEqual(expected.record);
  expect(store.uploads.get(record.id)?.json).toBe(JSON.stringify(expected.record));
  expect(store.chunks.get(record.id)?.size).toBe(3);
  expect(store.saved.size).toBe(0);
  if (!result.statement) throw new Error("Expected publication");
  store.commit(result.statement);
  expect(store.saved.get(record.id)?.recordJson).toBe(JSON.stringify(expected.record));
});

test("未公開の再送を重複なく進め、内容の異なるmanifestを拒否する", async () => {
  const store = new MemoryRecordStore();
  const first = await prepareSnapshotMatch(store, record, validation);
  expect(await prepareSnapshotMatch(store, record, validation)).toEqual(first);
  await expect(
    prepareSnapshotMatch(store, { ...record, game: { value: 999 } }, validation),
  ).rejects.toThrow("Conflicting match upload");
  expect(store.uploads.size).toBe(1);
  expect(store.chunks.get(record.id)?.size).toBe(3);
  expect(store.saved.size).toBe(0);
});

test("保存済みなら再送のencodeを呼ばず、元の本体を返して公開の書き込みを作らない", async () => {
  const store = new MemoryRecordStore();
  const canonical = encodeSnapshotMatch(record).record;
  store.saved.set(record.id, { game: record.settings.game, recordJson: JSON.stringify(canonical) });
  const result = await prepareSnapshotMatch(store, record, {
    ...validation,
    encode: () => {
      throw new Error("Must not encode");
    },
  });
  expect(result).toEqual({ canonical, statement: null });
  expect(store.uploads.size).toBe(0);
  expect(store.chunks.size).toBe(0);
});

test("別ゲームの保存済みIDは拒否する", async () => {
  const store = new MemoryRecordStore();
  store.saved.set(record.id, { game: "shogi", recordJson: "{}" });
  await expect(prepareSnapshotMatch(store, record, validation)).rejects.toThrow(
    "Match ID belongs to another game",
  );
});

test("転送の途中失敗から最初の進捗で再開し、公開は呼び出し元まで待つ", async () => {
  const store = new MemoryRecordStore();
  store.failChunk = 1;
  await expect(prepareSnapshotMatch(store, record, validation)).rejects.toThrow(
    "Chunk unavailable",
  );
  expect(store.saved.size).toBe(0);
  store.failChunk = null;
  const result = await prepareSnapshotMatch(store, record, validation);
  expect(store.chunks.get(record.id)?.size).toBe(3);
  expect(store.saved.size).toBe(0);
  if (!result.statement) throw new Error("Expected publication");
  store.commit(result.statement);
  expect(store.saved.size).toBe(1);
});

test("同じ件数でも既存チャンクの内容が違えば公開しない", async () => {
  const store = new MemoryRecordStore();
  await prepareSnapshotMatch(store, record, validation);
  const row = store.chunks.get(record.id)!.get(2)!;
  row.events_json = '[{"value":999}]';
  await expect(prepareSnapshotMatch(store, record, validation)).rejects.toThrow(
    "Match chunk content mismatch",
  );
  expect(store.saved.size).toBe(0);
});
