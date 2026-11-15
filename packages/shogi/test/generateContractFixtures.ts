import {
  applyAction,
  chooseCpuAction,
  createInitialState,
  canProposeImpasse,
  setDrawProposal,
  declareEnteringKing,
  getLegalActions,
  type ShogiAction,
  type ShogiState,
} from "../src";
import type { ShogiEvent } from "../src/definition";

const initial = { players: { south: "cpu-south", north: "cpu-north" } };
const directory = new URL("../../../test-fixtures/matches/", import.meta.url);

async function save(name: string, state: ShogiState, events: ShogiEvent[], generation: object) {
  if (state.status !== "finished") throw new Error("Fixture must finish");
  const { repetitions: _history, ...game } = state;
  await Bun.write(
    new URL(`standard-shogi-${name}.json`, directory),
    JSON.stringify(
      {
        detail: {
          generation,
          game,
          replay: { rulesVersion: 1, initial, eventCount: events.length },
        },
        events,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(name, state.moveNumber, events.length, state.result);
}

async function randomGame(seed: number, declaration = false) {
  let value = seed;
  const random = () => (value = (Math.imul(value, 1664525) + 1013904223) >>> 0) / 4294967296;
  let state = createInitialState(initial);
  const events: ShogiEvent[] = [];
  let proposed = false;
  while (state.status === "playing") {
    if (!proposed && canProposeImpasse(state)) {
      const side = state.turn === "south" ? "north" : "south";
      for (const proposed of [true, false]) {
        const result = setDrawProposal(state, side, proposed);
        if (!result.ok) throw new Error(result.reason);
        events.push({ type: "drawProposal", side, proposed });
        state = result.state;
      }
      proposed = true;
      if (declaration && state.status === "playing") {
        const result = declareEnteringKing(state, state.turn);
        if (!result.ok) throw new Error(result.reason);
        events.push({ type: "declaration", side: state.turn });
        state = result.state;
        break;
      }
    }
    if (state.status !== "playing") throw new Error("Unexpected finish");
    const action = chooseCpuAction(state, 1, random);
    if (!action) throw new Error("Missing CPU action");
    const result = applyAction(state, state.turn, action);
    if (!result.ok) throw new Error(result.reason);
    events.push({ type: "action", side: state.turn, action });
    state = result.state;
  }
  await save(declaration ? "declaration" : `cpu-${seed}`, state, events, {
    command: "mise exec -- bun packages/shogi/test/generateContractFixtures.ts",
    cpuLevel: 1,
    seed,
    random: "LCG: uint32(imul(value,1664525)+1013904223)/2^32",
    policy: declaration
      ? "最初の入玉・王手なしで手番外の提案・取消後、手番側が宣言（条件不足の敗北）"
      : "最初の入玉・王手なしで手番外の提案・取消を挿入し、CPU同士で終局まで続行",
  });
}

async function repetitionGame() {
  let state = createInitialState(initial);
  const events: ShogiEvent[] = [];
  const randomValues: number[] = [];
  const cycle: ShogiAction[] = [
    { type: "movePiece", from: { x: 3, y: 8 }, to: { x: 3, y: 7 }, promote: false },
    { type: "movePiece", from: { x: 3, y: 0 }, to: { x: 3, y: 1 }, promote: false },
    { type: "movePiece", from: { x: 3, y: 7 }, to: { x: 3, y: 8 }, promote: false },
    { type: "movePiece", from: { x: 3, y: 1 }, to: { x: 3, y: 0 }, promote: false },
  ];
  for (let i = 0; i < 12; i++) {
    if (state.status !== "playing") throw new Error("Early repetition");
    const count = getLegalActions(state).length;
    const value = Array.from({ length: count }, (_, n) => (n + 0.5) / count).find(
      (n) => JSON.stringify(chooseCpuAction(state, 1, () => n)) === JSON.stringify(cycle[i % 4]),
    );
    if (value === undefined) throw new Error("Missing cycle move");
    randomValues.push(value);
    const action = chooseCpuAction(state, 1, () => value)!;
    const result = applyAction(state, state.turn, action);
    if (!result.ok) throw new Error(result.reason);
    events.push({ type: "action", side: state.turn, action });
    state = result.state;
  }
  await save("repetition", state, events, {
    cpuLevel: 1,
    randomValues,
    policy: "金の往復を選ぶ固定乱数列を両CPUへ注入。初期局面を含め4回目で千日手",
    command: "mise exec -- bun packages/shogi/test/generateContractFixtures.ts",
  });
}

await randomGame(1);
await randomGame(4);
await randomGame(4, true);
await repetitionGame();
