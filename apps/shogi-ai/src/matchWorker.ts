import { applyAction, chooseCpuAction, sides } from "@tetraboard/four-shogi";
import { chooseLv3Action } from "@tetraboard/four-shogi/lv3";
import { openingPosition } from "../../../packages/four-shogi/bench/measurement";
import { AiStore } from "./store";
import type { Sample } from "./statistics";
import { resolvedOutcome } from "./outcome";
const store = new AiStore(process.env.AI_DATA_DIR ?? ".shogi-ai");
const id = process.argv[2];
if (!id) throw new Error("Missing task id");
const saved = store.task(id);
const { task } = saved;
const model = store.model(task.modelId);
const opponent = task.opponentId === "lv2" ? null : store.model(task.opponentId);
let state =
  saved.state ?? openingPosition("singles", task.profileId === "singles-restricted", task.seed);
let ply = saved.ply;
const events = saved.events;
let stopped = false;
let resolved: Sample | null = resolvedOutcome(
  state,
  task.seat,
  task.seed,
  ply,
  task.pool === "tune",
);
process.on("SIGTERM", () => {
  stopped = true;
});
while (state.status === "playing" && ply < task.maxPlies && !stopped && !resolved) {
  const selected = state.turn === task.seat ? model : opponent;
  const action = selected
    ? chooseLv3Action(state, { maxWork: selected.maxWork, weights: selected.weights }).action
    : chooseCpuAction(state, 2);
  if (!action) throw new Error("Missing legal action");
  const side = state.turn;
  const result = applyAction(state, side, action);
  if (!result.ok) throw new Error(`Illegal move: ${result.reason}`);
  state = result.state;
  ply++;
  events.push({ type: "action", side, action });
  // 各手の確定状態を保存し、強制停止後も完了済みの手を再計算しません。
  store.checkpoint(id, state, events, ply);
  resolved = resolvedOutcome(state, task.seat, task.seed, ply, task.pool === "tune");
  if (ply % 8 === 0) {
    console.log(JSON.stringify({ id, ply }));
    await Bun.sleep(0);
  }
}
if (!stopped) {
  const sample: Sample = resolved ?? {
    seed: task.seed,
    seat: task.seat,
    rank: null,
    reward: 0,
    draw: false,
    unfinished: true,
    plies: ply,
    termination: "limit",
  };
  if (!sides.includes(task.seat)) throw new Error("Invalid seat");
  store.finish(id, sample);
  console.log(JSON.stringify({ id, result: sample }));
}
store.close();
