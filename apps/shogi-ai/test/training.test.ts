import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lv3Weights } from "@tetraboard/four-shogi/lv3";
import { aiModelSchema, signAiRequest } from "@tetraboard/protocol/shogi-ai";
import { AiStore, sourceIdentity } from "../src/store";
import { parseOptions, mutateModel, Trainer } from "../src/training";
import { metrics, pairedInterval, type Sample } from "../src/statistics";
import { createApi } from "../src/server";
test("未測定をnullで返し、対応系列のない比較と少標本を採用判定に使いません", () => {
  expect(metrics([]).winRate).toBeNull();
  expect(metrics([]).averageRank).toBeNull();
  const parent: Sample[] = Array.from({ length: 32 }, (_, i) => ({
    seed: Math.floor(i / 4),
    seat: (["south", "west", "north", "east"] as const)[i % 4],
    rank: 3,
    reward: 1 / 3,
    draw: false,
    unfinished: false,
    plies: 100,
  }));
  expect(pairedInterval(parent.slice(0, 28), parent)).toBeNull();
  expect(
    pairedInterval(
      parent.map((s) => ({ ...s, reward: 2 / 3 })),
      parent,
    )![0],
  ).toBeGreaterThan(0);
  expect(pairedInterval(parent.slice(0, 31), parent)).toBeNull();
});
test("同じseedの変更は決定的で、重みの上限と下限を守ります", () => {
  const model = aiModelSchema.parse({
    schemaVersion: 1,
    id: "initial",
    profileId: "singles-restricted",
    generation: 0,
    parentId: null,
    codeCommit: "test",
    sourceHash: "a".repeat(64),
    createdAt: 0,
    weights: lv3Weights,
    maxWork: 128,
  });
  const identity = { codeCommit: "test", sourceHash: "a".repeat(64) };
  const a = mutateModel(model, 1, 1, identity),
    b = mutateModel(model, 1, 1, identity);
  expect(a.weights).toEqual(b.weights);
  expect(a.weights).not.toEqual(model.weights);
  expect(model.weights).toEqual(lv3Weights);
  expect(() => parseOptions(["--workers", "6"])).toThrow();
});
test("永続モデルは改変できず、監視APIは署名・期限・nonceの再使用を検証します", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shogi-api-")),
    store = new AiStore(directory);
  try {
    const identity = await sourceIdentity(),
      model = aiModelSchema.parse({
        ...identity,
        schemaVersion: 1,
        id: "test",
        profileId: "singles-restricted",
        generation: 0,
        parentId: null,
        createdAt: Date.now(),
        weights: lv3Weights,
        maxWork: 128,
      });
    await store.saveModel(model);
    await expect(
      store.saveModel({ ...model, weights: { ...model.weights, check: 100 } }),
    ).rejects.toThrow("immutable");
    const token = "t".repeat(64),
      api = createApi(store, token),
      url = "http://localhost/v1/admin/status";
    expect((await api(new Request(url))).status).toBe(401);
    expect((await api(new Request("http://localhost/healthz"))).status).toBe(200);
    const at = Date.now(),
      nonce = crypto.randomUUID(),
      signature = await signAiRequest(token, "GET", "/v1/admin/status", "", at, nonce),
      headers = { "x-ai-at": String(at), "x-ai-nonce": nonce, "x-ai-signature": signature };
    expect((await api(new Request(url, { headers }))).status).toBe(503);
    expect((await api(new Request(url, { headers }))).status).toBe(401);
    expect((await api(new Request(url, { method: "POST" }))).status).toBe(404);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
// 2回の停止が各最大5秒待つため、起動・再開を含む試験の期限を別に確保します。
test("2並列の両ルール自己対局を停止・再開し、保存済み着手とモデルを維持します", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shogi-training-")),
    store = new AiStore(directory);
  const options = {
    ...parseOptions([
      "--seconds",
      "3",
      "--workers",
      "2",
      "--seeds",
      "1",
      "--max-plies",
      "4",
      "--work",
      "128",
    ]),
    minFreeBytes: 1,
  };
  let trainer = new Trainer(store, options);
  try {
    await trainer.start();
    await Bun.sleep(500);
    await trainer.stop();
    const snapshot = trainer.snapshot();
    expect(snapshot.profiles.length).toBe(2);
    expect(snapshot.learning.stage).toBe("stopped");
    const tasks = store.pending();
    expect(tasks.length).toBeGreaterThan(0);
    const completed = store.db
      .query<{ n: number }, []>("SELECT count(*) n FROM tasks WHERE result IS NOT NULL")
      .get()!.n;
    trainer = new Trainer(store, options);
    await trainer.start();
    await Bun.sleep(500);
    await trainer.stop();
    expect(trainer.snapshot().learning.games).toBeGreaterThanOrEqual(completed);
    expect(trainer.snapshot().profiles.every((p) => p.champion.generation === 0)).toBe(true);
  } finally {
    await trainer.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
