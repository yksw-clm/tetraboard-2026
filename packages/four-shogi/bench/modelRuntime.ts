import { resolve } from "node:path";
import { ModelInferenceClient } from "../src/modelInference";

export type DataModel = { modelId: string; artifactSha256: string; codeHash: string };
export type ModelRuntime = { python: string; directory: string };
export async function modelIdentity(directory: string): Promise<DataModel> {
  const file = Bun.file(resolve(directory, "manifest.json"));
  if (file.size > 256 * 1024) throw new Error("モデルmanifestの容量上限です");
  const meta = await file.json();
  if (
    meta.format !== "four-shogi-inference-v1" ||
    !/^four-shogi-tiny-policy-value-v1:[0-9a-f]{64}$/.test(meta.modelId) ||
    !/^[0-9a-f]{64}$/.test(meta.weights?.sha256) ||
    !/^[0-9a-f]{64}$/.test(meta.codeHash)
  )
    throw new Error("推論モデルの識別が不正です");
  return { modelId: meta.modelId, artifactSha256: meta.weights.sha256, codeHash: meta.codeHash };
}
export async function startModelRuntime(runtime: ModelRuntime, expected?: DataModel) {
  const identity = await modelIdentity(runtime.directory);
  if (
    expected &&
    (Object.keys(identity) as (keyof DataModel)[]).some((key) => identity[key] !== expected[key])
  )
    throw new Error("生成manifestとモデルartifact/コードが不一致です");
  const client = await ModelInferenceClient.start([
    runtime.python,
    resolve(import.meta.dir, "../../../training/four-shogi-ai/inference.py"),
    "serve",
    "--model",
    resolve(runtime.directory),
    "--fixture",
    resolve(runtime.directory, "probe.json"),
  ]);
  if (
    client.loadedModel.modelId !== identity.modelId ||
    client.loadedModel.codeHash !== identity.codeHash
  ) {
    client.close();
    throw new Error("ロードしたモデルの識別が不一致です");
  }
  return { client, identity, evaluator: client.asEvaluator() };
}
