import { expect, test } from "bun:test";
import { restoreAnalysisPosition } from "@tetraboard/four-shogi/analysis";
import { ProcessPool } from "../src/processPool";
import { config, request } from "./fixtures";
test("別のBunプロセスで完全局面を復元し共通探索を実行して停止する", async () => {
  const pool = new ProcessPool({ ...config, modelDirectory: "" });
  try {
    await pool.start();
    const input = request(30, "cpu");
    input.stateHash = (await restoreAnalysisPosition(input.position)).stateHash;
    input.budget.maxWork = 128;
    const result = await new Promise<unknown>((resolve, reject) =>
      pool.run(0, crypto.randomUUID(), input, 500, (value, error) =>
        error ? reject(new Error(error)) : resolve(value),
      ),
    );
    expect(result).toMatchObject({
      result: {
        input: { stateHash: input.stateHash },
        versions: { codeVersion: config.codeVersion },
        model: { usedModelId: null },
      },
    });
    expect(pool.pids().length).toBe(2);
  } finally {
    await pool.close();
  }
  expect(pool.pids()).toEqual([]);
}, 15000);
