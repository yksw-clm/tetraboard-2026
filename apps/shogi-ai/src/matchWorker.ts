import { applyAction, chooseCpuAction, sides } from "@tetraboard/four-shogi";
import { chooseLv3Action } from "@tetraboard/four-shogi/lv3";
import { openingPosition } from "../../../packages/four-shogi/bench/measurement";
import { AiStore } from "./store";
import type { Sample } from "./statistics";
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
process.on("SIGTERM", () => {
  stopped = true;
});
while (state.status === "playing" && ply < task.maxPlies && !stopped) {
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
  if (ply % 8 === 0) {
    console.log(JSON.stringify({ id, ply }));
    await Bun.sleep(0);
  }
}
if (!stopped) {
  const finished =
    state.status === "finished" && state.result.mode === "singles" ? state.result : null;
  const rank = finished?.standings.find((s) => s.side === task.seat)?.rank ?? null;
  const draw = !!finished && finished.reason !== "last_player";
  const sample: Sample = {
    seed: task.seed,
    seat: task.seat,
    rank,
    reward: finished && rank !== null ? (4 - rank) / 3 : 0,
    draw,
    unfinished: !finished,
    plies: ply,
  };
  if (!sides.includes(task.seat)) throw new Error("Invalid seat");
  store.finish(id, sample);
  console.log(JSON.stringify({ id, result: sample }));
}
store.close();
