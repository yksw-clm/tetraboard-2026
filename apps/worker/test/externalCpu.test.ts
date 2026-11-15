import { expect, test } from "vitest";
import { defineGame } from "@tetraboard/game-contract";
import {
  currentExternalCpuJob,
  prepareExternalCpu,
  completeExternalCpu,
  type ExternalCpuJob,
  type ExternalCpuRuntime,
} from "../src/rooms/externalCpu";

interface Types {
  state: number;
  seat: "south";
  cpuLevel: 1;
  settings: {};
  result: number;
  action: { type: "dropPiece"; to: number };
  event: number;
  rejection: "illegal";
  externalMove: string;
  externalOptions: {};
}
const definition = defineGame<Types, "example">({
  catalog: { id: "example", seats: ["south"], rating: "none", defaultSettings: {} },
  rules: {
    createInitialState: () => 0,
    getTurn: () => "south",
    getResult: () => null,
    applyAction: (state, _, action) =>
      action.to === state + 1
        ? { ok: true, state: action.to, event: action.to }
        : { ok: false, reason: "illegal" },
    eliminateSeat: (state) => ({ state, event: state }),
  },
  cpu: {
    chooseAction: () => null,
    external: {
      getPositionKey: String,
      createRequest: (state) => ({ moves: [state] }),
      readMove: (move) =>
        move.startsWith("drop:") ? { type: "dropPiece", to: Number(move.slice(5)) } : null,
      fallbackAction: (state) => ({ type: "dropPiece", to: state + 1 }),
    },
  },
  replay: () => [],
});
type Job = ExternalCpuJob & { roundId: string };
function setup() {
  let stored: Job | null = null;
  let saved: { action: Types["action"]; applyAt: number; external: boolean } | null = null;
  const runtime: ExternalCpuRuntime<Types, Job> = {
    definition,
    state: 3,
    seat: "south",
    level: 1,
    loadJob: () => stored,
    hasJob: () => stored !== null,
    deleteJob: () => {
      stored = null;
    },
    saveJob: (job) => {
      stored = job;
    },
    matchesContext: (job) => job.roundId === "round",
    sameRequest: () => true,
    clockExpired: (now) => now >= 1000,
    hasCpuJob: () => saved !== null,
    saveAction: (_, action, now, external) => {
      saved = { action, applyAt: now + 1, external };
    },
  };
  return { runtime, queued: () => saved };
}

test.each(["drop:4", "drop:9", "unreadable", null])(
  "文字列の応答 %s から合法な任意の操作を一度だけ予約する",
  (move) => {
    const { runtime, queued } = setup();
    const job = prepareExternalCpu(runtime, { roundId: "round" }, 10, 100)!;
    expect(currentExternalCpuJob(runtime)).toEqual(job);
    expect(completeExternalCpu(runtime, job, move, 20)).toBe(true);
    expect(queued()).toEqual({
      action: { type: "dropPiece", to: 4 },
      applyAt: 21,
      external: move === "drop:4",
    });
    expect(currentExternalCpuJob(runtime)).toBeNull();
    expect(completeExternalCpu(runtime, job, move, 20)).toBe(false);
  },
);

test("古い局面を捨て、期限切れを予備へ回し、時計切れ・別要求・別局を拒否する", () => {
  const { runtime, queued } = setup();
  const stale = prepareExternalCpu(runtime, { roundId: "round" }, 10, 100)!;
  runtime.state = 4;
  expect(completeExternalCpu(runtime, stale, "drop:4", 20)).toBe(false);
  expect(prepareExternalCpu(runtime, null, 20, 100)).toBeNull();
  expect(runtime.hasJob()).toBe(false);
  const job = prepareExternalCpu(runtime, { roundId: "round" }, 20, 100)!;
  expect(
    completeExternalCpu(runtime, { ...job, requestId: crypto.randomUUID() }, "drop:5", 30),
  ).toBe(false);
  expect(completeExternalCpu(runtime, { ...job, roundId: "old" }, "drop:5", 30)).toBe(false);
  expect(completeExternalCpu(runtime, job, "drop:5", 1000)).toBe(false);
  expect(queued()).toBeNull();
  expect(prepareExternalCpu(runtime, { roundId: "round" }, 100, 200)).toBeNull();
  expect(queued()).toEqual({ action: { type: "dropPiece", to: 5 }, applyAt: 101, external: false });
});

test("予備操作の省略時は指定レベル・乱数・履歴を使い、合法性の確認にも履歴を渡す", () => {
  interface HistoryTypes extends Types {
    history: ReadonlyMap<number, number>;
  }
  const { fallbackAction: _fallback, ...external } = definition.cpu.external!;
  const withHistory = defineGame<HistoryTypes, "example">({
    ...definition,
    rules: {
      ...definition.rules,
      applyAction: (state, _, action, history) =>
        action.to === history?.get(state)
          ? { ok: true, state: action.to, event: action.to }
          : { ok: false, reason: "illegal" },
    },
    cpu: {
      external,
      chooseAction: (state, _, level, random, history) => {
        const to = history?.get(state + level + random());
        return to === undefined ? null : { type: "dropPiece", to };
      },
    },
  });
  for (const move of ["drop:12", "drop:99", null]) {
    const { runtime, queued } = setup();
    const historyRuntime: ExternalCpuRuntime<HistoryTypes, Job> = {
      ...runtime,
      definition: withHistory,
      random: () => 0.5,
      history: new Map([
        [3, 12],
        [4.5, 12],
      ]),
    };
    const job = prepareExternalCpu(historyRuntime, { roundId: "round" }, 10, 100)!;
    expect(completeExternalCpu(historyRuntime, job, move, 20)).toBe(true);
    expect(queued()).toEqual({
      action: { type: "dropPiece", to: 12 },
      applyAt: 21,
      external: move === "drop:12",
    });
  }
});
