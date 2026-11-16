import { expect, test } from "bun:test";
import { advanceShogiMatchSave, type MatchSaveProgress } from "../src";
import { MemoryRecordStore, events, normalize, parse, record, source } from "./memoryPorts";

const upload = { phase: "upload", cursor: 0 } as const;
const verify = { phase: "verify", cursor: 0 } as const;
function advance(store: MemoryRecordStore, progress: MatchSaveProgress) {
  return advanceShogiMatchSave(store, record, progress, source, parse, normalize);
}

test("将棋の転送と照合は各回400件まで進み、公開は呼び出し元のbatchまで待つ", async () => {
  const store = new MemoryRecordStore();
  expect(await advance(store, upload)).toEqual({
    status: "progress",
    progress: { phase: "upload", cursor: 4 },
  });
  expect(
    [...store.chunks.get(record.id)!.values()].reduce((n, row) => n + row.event_count, 0),
  ).toBe(400);
  expect(await advance(store, { phase: "upload", cursor: 4 })).toEqual({
    status: "progress",
    progress: verify,
  });
  expect(await advance(store, verify)).toEqual({
    status: "progress",
    progress: { phase: "verify", cursor: 4 },
  });
  const ready = await advance(store, { phase: "verify", cursor: 4 });
  expect(ready.status).toBe("publish");
  expect(store.saved.size).toBe(0);
  if (ready.status !== "publish") throw new Error("Expected publication");
  store.commit(ready.statement);
  expect(store.saved.get(record.id)?.recordJson).toBe(JSON.stringify(record));
  expect(
    [...store.chunks.get(record.id)!.values()].flatMap((row) => JSON.parse(row.events_json)),
  ).toEqual(events);
});

test("チャンクの途中失敗と応答喪失後に同じ保存待ちから再送でき、重複しない", async () => {
  const store = new MemoryRecordStore();
  store.failChunk = 2;
  await expect(advance(store, upload)).rejects.toThrow("Chunk unavailable");
  expect(store.saved.size).toBe(0);
  expect(store.chunks.get(record.id)?.size).toBe(2);
  store.failChunk = null;
  await advance(store, upload);
  await advance(store, upload);
  await advance(store, { phase: "upload", cursor: 4 });
  expect(store.uploads.size).toBe(1);
  expect(store.chunks.get(record.id)?.size).toBe(6);
  await advance(store, verify);
  const ready = await advance(store, { phase: "verify", cursor: 4 });
  if (ready.status !== "publish") throw new Error("Expected publication");
  store.failPublication = true;
  expect(() => store.commit(ready.statement)).toThrow("Publication unavailable");
  expect(store.saved.size).toBe(0);
  store.failPublication = false;
  const retry = await advance(store, { phase: "verify", cursor: 4 });
  if (retry.status !== "publish") throw new Error("Expected publication");
  store.commit(retry.statement);
  store.commit(retry.statement);
  expect(store.saved.size).toBe(1);
});

test("保存済みなら内容の異なる再送もチャンクを読まず、保存処理を行わない", async () => {
  const store = new MemoryRecordStore();
  const saved = { game: "shogi", recordJson: "canonical" };
  store.saved.set(record.id, saved);
  const forbidden = () => {
    throw new Error("Must not read or validate");
  };
  const result = await advanceShogiMatchSave(
    store,
    { ...record, endedAtMs: 999 },
    upload,
    forbidden,
    forbidden,
    forbidden,
  );
  expect(result).toEqual({ status: "saved", saved });
  expect(store.uploads.size).toBe(0);
  expect(store.chunks.size).toBe(0);
});

test("別ゲームが同じIDを使っていたら拒否する", async () => {
  const store = new MemoryRecordStore();
  store.saved.set(record.id, { game: "four-shogi", recordJson: "canonical" });
  await expect(advance(store, upload)).rejects.toThrow("Match ID belongs to another game");
  expect(store.uploads.size).toBe(0);
});

test("未公開の内容の異なる再送を拒み、元のmanifestを保つ", async () => {
  const store = new MemoryRecordStore();
  await advance(store, upload);
  await expect(
    advanceShogiMatchSave(store, { ...record, endedAtMs: 999 }, upload, source, parse, normalize),
  ).rejects.toThrow("Conflicting Shogi match upload");
  expect(store.uploads.get(record.id)?.json).toBe(JSON.stringify(record));
  expect(store.saved.size).toBe(0);
});

test("件数が合う異なるチャンクも照合で拒否し、修復後に再開できる", async () => {
  const store = new MemoryRecordStore();
  await advance(store, upload);
  await advance(store, { phase: "upload", cursor: 4 });
  const row = store.chunks.get(record.id)!.get(0)!;
  const original = row.events_json;
  row.events_json = JSON.stringify(Array<number>(100).fill(-1));
  await expect(advance(store, verify)).rejects.toThrow("Match chunk content mismatch");
  expect(store.saved.size).toBe(0);
  row.events_json = original;
  expect(await advance(store, verify)).toEqual({
    status: "progress",
    progress: { phase: "verify", cursor: 4 },
  });
});

test("空の将棋棋譜も転送、照合の順に進む", async () => {
  const store = new MemoryRecordStore();
  const empty = { ...record, replay: { eventCount: 0 } };
  const first = await advanceShogiMatchSave(store, empty, upload, () => [], parse, normalize);
  expect(first).toEqual({ status: "progress", progress: verify });
  const ready = await advanceShogiMatchSave(store, empty, verify, () => [], parse, normalize);
  if (ready.status !== "publish") throw new Error("Expected publication");
  store.commit(ready.statement);
  expect(store.saved.size).toBe(1);
});
