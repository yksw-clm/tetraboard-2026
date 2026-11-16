import { expect, test } from "bun:test";
import { ensureMatchUpload, advanceMatchChunks } from "../src";
import { MemoryRecordStore, normalize, parse, record, source } from "./memoryPorts";

test("同じmanifestの再送は重複も上書きもしない", async () => {
  const store = new MemoryRecordStore();
  await ensureMatchUpload(store, record, 6, normalize);
  await ensureMatchUpload(store, record, 6, normalize);
  expect(store.uploads.size).toBe(1);
  expect(store.uploads.get(record.id)).toEqual({
    json: JSON.stringify(record),
    count: 501,
    chunks: 6,
  });
});

test("伏せ字などの正規化後の内容で照合し、古いmanifestを条件付きで更新する", async () => {
  const store = new MemoryRecordStore();
  const original = { ...record, name: "original" };
  const anonymous = { ...record, name: "anonymous" };
  await ensureMatchUpload(store, original, 6, normalize);
  const redact = async (json: string) => JSON.stringify({ ...JSON.parse(json), name: "anonymous" });
  await ensureMatchUpload(store, anonymous, 6, redact);
  expect(store.uploads.get(record.id)?.json).toBe(JSON.stringify(anonymous));
});

test("照合中にmanifestが変わったら更新せず、競合として拒否する", async () => {
  const store = new MemoryRecordStore();
  const original = { ...record, name: "original" };
  await ensureMatchUpload(store, original, 6, normalize);
  const redact = async (json: string) => {
    const value = JSON.parse(json);
    if (value.name === "original") store.uploads.get(record.id)!.json = "concurrent";
    return JSON.stringify({ ...value, name: "anonymous" });
  };
  await expect(
    ensureMatchUpload(store, { ...record, name: "anonymous" }, 6, redact),
  ).rejects.toThrow("Conflicting match upload");
  expect(store.uploads.get(record.id)?.json).toBe("concurrent");
});

test("manifestが読み返せなければチャンクを保存しない", async () => {
  const store = new MemoryRecordStore();
  store.readUpload = async () => null;
  await expect(ensureMatchUpload(store, record, 6, normalize)).rejects.toThrow(
    "Missing match upload",
  );
  expect(store.chunks.size).toBe(0);
});

for (const cursor of [-1, 0.5, 7]) {
  test("不正な保存進捗を拒否する: " + cursor, async () => {
    const store = new MemoryRecordStore();
    await expect(
      advanceMatchChunks(store, record.id, 501, { phase: "upload", cursor }, source, parse),
    ).rejects.toThrow("Invalid match save progress");
    expect(store.chunks.size).toBe(0);
  });
}

test("照合時の欠落と不連続を拒否し、公開しない", async () => {
  const store = new MemoryRecordStore();
  const verify = { phase: "verify", cursor: 0 } as const;
  await expect(advanceMatchChunks(store, record.id, 501, verify, source, parse)).rejects.toThrow(
    "Missing match replay chunk",
  );
  await advanceMatchChunks(store, record.id, 501, { phase: "upload", cursor: 0 }, source, parse);
  const first = store.chunks.get(record.id)!.get(0)!;
  first.chunk_index = 1;
  await expect(advanceMatchChunks(store, record.id, 501, verify, source, parse)).rejects.toThrow(
    "Match chunk index mismatch",
  );
  expect(store.saved.size).toBe(0);
});
