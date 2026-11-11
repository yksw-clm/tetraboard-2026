import { mkdir, writeFile } from "node:fs/promises";
import { applyAction, createInitialState, getLegalMoves } from "../../four-reversi/src/index";

const origin = process.env.AI_SERVICE_URL;
const token = process.env.AI_SERVICE_TOKEN;
if (origin !== "https://tetraboard-ai-validation.chaossi-lab.workers.dev" || !token)
  throw Error("検証用のAI_SERVICE_URLとAI_SERVICE_TOKENが必要です");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const agents = ["random", "greedy", "maxn"] as const;
const states = new Map<number, ReturnType<typeof createInitialState>>();
let state = createInitialState("singles");
for (let ply = 0; state.status === "playing" && ply <= 44; ply++) {
  if ([0, 12, 28, 44].includes(ply)) states.set(ply, state);
  const next = applyAction(state, { type: "placeStone", position: getLegalMoves(state)[0]! });
  if (!next.ok) throw Error("測定局面の生成に失敗しました");
  state = next.state;
}
function body(ply: number, agent: (typeof agents)[number], heavy = false) {
  const position = states.get(ply)!;
  return {
    api_version: 1,
    game_id: "four-reversi",
    ruleset_version: "four-reversi-singles-v1",
    state_version: 1,
    request_id: "00000000-0000-4000-8000-000000000007",
    position_revision: "0".repeat(64),
    agent_id: `four-reversi-${agent}-v1`,
    seed: 7,
    ...(agent === "maxn"
      ? { budget: { max_depth: heavy ? 4 : 3, max_nodes: heavy ? 4096 : 1024 } }
      : {}),
    state: {
      board: position.board,
      turn: position.turn,
      moveNumber: position.moveNumber,
      lastMove: position.lastMove,
      consecutivePasses: position.consecutivePasses,
    },
  };
}
async function status() {
  const response = await fetch(`${origin}/admin/status`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`status: ${response.status}`);
  return response.json() as Promise<{ status: string; lastChange: number }>;
}
async function move(ply: number, agent: (typeof agents)[number], heavy = false) {
  const start = performance.now();
  const response = await fetch(`${origin}/v1/move`, {
    method: "POST",
    headers,
    body: JSON.stringify(body(ply, agent, heavy)),
    signal: AbortSignal.timeout(60000),
    redirect: "manual",
  });
  const result = await response.json();
  const elapsed = performance.now() - start;
  if (response.ok) {
    const candidate = result as { position: { x: number; y: number } };
    if (
      !getLegalMoves(states.get(ply)!).some(
        (p) => p.x === candidate.position.x && p.y === candidate.position.y,
      )
    )
      throw Error("Serviceが不正手を返しました");
  }
  return {
    status: response.status,
    elapsed_ms: elapsed,
    response: result,
    ray: response.headers.get("cf-ray"),
  };
}
function summary(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    count: values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.ceil(values.length * 0.5) - 1],
    p95: sorted[Math.ceil(values.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}
const started = new Date().toISOString();
const records: unknown[] = [];
const initial = await status();
if (initial.status !== "stopped")
  throw Error("停止状態から開始してください（要求を止めて16秒以上待ちます）");
const unauth = await fetch(`${origin}/v1/move`, { method: "POST", body: "{}" });
if (unauth.status !== 401) throw Error("認証なしの要求が拒否されませんでした");
const afterUnauth = await status();
if (afterUnauth.status !== "stopped") throw Error("認証なしの要求後にContainerが起動しました");
const cold = [];
for (let i = 0; i < 3; i++) {
  if (i > 0) await Bun.sleep(16000);
  const before = await status();
  if (before.status !== "stopped") throw Error("cold測定前にContainerが停止していません");
  const result = await move(0, "maxn");
  records.push({ phase: "cold", before, ...result });
  if (result.status !== 200) throw Error(`起動後の要求失敗: ${result.status}`);
  cold.push(result.elapsed_ms);
}
const warm = [];
for (const agent of agents) {
  const times: number[] = [];
  for (const ply of states.keys()) {
    let first: string | undefined;
    for (let i = 0; i < 10; i++) {
      const result = await move(ply, agent);
      if (result.status !== 200) throw Error(`warm要求失敗: ${result.status}`);
      const serialized = JSON.stringify(result.response);
      if (first && first !== serialized) throw Error("同一要求の結果が一致しません");
      first = serialized;
      times.push(result.elapsed_ms);
      records.push({ phase: "warm", agent, ply, ...result });
    }
  }
  warm.push({ agent, elapsed_ms: summary(times) });
}
const concurrent = [];
for (const width of [2, 4, 8]) {
  const responses = [];
  for (let batch = 0; batch < 5; batch++) {
    const batchResults = await Promise.all(
      Array.from({ length: width }, () => move(12, "maxn", true)),
    );
    responses.push(...batchResults);
    records.push(...batchResults.map((result) => ({ phase: "concurrent", width, ...result })));
  }
  if (responses.some((r) => ![200, 503].includes(r.status)))
    throw Error("予期しない負荷試験の応答です");
  concurrent.push({
    width,
    statuses: responses.reduce<Record<number, number>>((a, r) => {
      a[r.status] = (a[r.status] ?? 0) + 1;
      return a;
    }, {}),
    elapsed_ms: summary(responses.map((r) => r.elapsed_ms)),
  });
}
await Bun.sleep(16000);
const final = await status();
if (final.status !== "stopped") throw Error("測定後にContainerが自動停止しませんでした");
const report = {
  started_utc: started,
  finished_utc: new Date().toISOString(),
  origin,
  instance_type: "lite",
  max_instances: 1,
  sleep_after_seconds: 10,
  seed: 7,
  plies: [...states.keys()],
  initial_status: initial,
  after_unauthorized_status: afterUnauth,
  final_status: final,
  cold_elapsed_ms: summary(cold),
  warm,
  concurrent,
  records,
};
await mkdir(new URL("../results/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../results/phase2-cloud.json", import.meta.url),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify({ ...report, records: undefined }, null, 2));
