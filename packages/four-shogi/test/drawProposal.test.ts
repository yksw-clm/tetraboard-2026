import { describe, expect, test } from "bun:test";
import {
  applyAction,
  createInitialState,
  eliminateSide,
  getLegalActions,
  setDrawProposal,
  sides,
  type FourShogiState,
  type Side,
} from "../src/index";
import { positionKey } from "../src/repetition";
import { fixture, succeeded } from "./helpers";

function propose(state: FourShogiState, side: Side, proposed = true) {
  const result = setDrawProposal(state, side, proposed);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.state;
}

describe("引分提案", () => {
  test("提案・取消は手番、盤面、手数、履歴を変更せず、同じ設定は状態を保持する", () => {
    const state = createInitialState({
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
    });
    const original = structuredClone(state);
    const offered = propose(state, "south");
    expect(offered).toEqual({ ...state, drawProposals: ["south"] });
    expect(propose(offered, "south")).toBe(offered);
    expect(positionKey(offered)).toBe(positionKey(state));
    expect(propose(offered, "south", false)).toEqual(state);
    expect(state).toEqual(original);
  });

  test("手番外、脱落者、終局後、不正な提案を拒否する", () => {
    const state = fixture();
    expect(setDrawProposal(state, "west", true)).toEqual({ ok: false, reason: "not_your_turn" });
    expect(setDrawProposal(state, "south", null as unknown as boolean)).toEqual({
      ok: false,
      reason: "invalid_proposal",
    });
    const eliminated = succeeded(eliminateSide(state, "west", "left")).state;
    expect(setDrawProposal(eliminated, "west", true)).toEqual({
      ok: false,
      reason: "already_eliminated",
    });
    const finished = propose({ ...state, drawProposals: ["west", "north", "east"] }, "south");
    expect(setDrawProposal(finished, "south", false)).toEqual({
      ok: false,
      reason: "game_finished",
    });
  });

  for (const mode of ["singles", "doubles"] as const) {
    test(`${mode}: 提案を着手後も保持し、4人目の提案だけで引き分けになる`, () => {
      let state = fixture({ mode });
      for (const side of sides) {
        expect(state.turn).toBe(side);
        const before = state;
        state = propose(state, side);
        expect(state.moveNumber).toBe(before.moveNumber);
        if (side !== "east") {
          expect(state.status).toBe("playing");
          state = succeeded(applyAction(state, side, getLegalActions(state)[0])).state;
          expect(state.drawProposals).toContain(side);
        }
      }
      expect(state.status).toBe("finished");
      expect(state.turn).toBeNull();
      expect(state.result?.reason).toBe("agreement");
      if (state.result?.mode === "singles")
        expect(state.result.standings.map((entry) => entry.rank)).toEqual([1, 1, 1, 1]);
      else expect(state.result?.winner).toBeNull();
    });
  }

  for (const count of [2, 3]) {
    test(`${count}人生存で全員同意し、脱落者の順位と提案の除去を保持する`, () => {
      let state = fixture();
      for (const side of sides.slice(count))
        state = succeeded(eliminateSide(state, side, "left")).state;
      const active = sides.slice(0, count);
      state = { ...state, drawProposals: active.slice(1), turn: "south" } as FourShogiState;
      const finished = propose(state, "south");
      expect(finished.result?.reason).toBe("agreement");
      if (finished.result?.mode !== "singles") throw new Error("Expected singles result");
      for (const side of active)
        expect(finished.result.standings.find((entry) => entry.side === side)?.rank).toBe(1);
      for (const entry of state.eliminations)
        expect(
          finished.result.standings.find((standing) => standing.side === entry.side)?.rank,
        ).toBe(entry.rank!);
    });
  }

  test("手番外の脱落によって残り全員が同意状態になると即座に成立する", () => {
    const state = { ...fixture(), drawProposals: ["south", "west", "north"] as Side[] };
    const result = succeeded(eliminateSide(state, "east", "disconnected")).state;
    expect(result.result?.reason).toBe("agreement");
    expect(result.moveNumber).toBe(0);
  });

  test("提案した人が脱落すると提案を除去し、通常の勝敗を優先する", () => {
    let state: FourShogiState = { ...fixture(), drawProposals: ["south", "east"] };
    state = succeeded(eliminateSide(state, "east", "timeout")).state;
    expect(state.drawProposals).toEqual(["south"]);
    state = succeeded(eliminateSide(state, "west", "left")).state;
    state = succeeded(eliminateSide(state, "north", "left")).state;
    expect(state.result?.reason).toBe("last_player");
    const doubles = succeeded(
      eliminateSide(
        { ...fixture({ mode: "doubles" }), drawProposals: ["south", "west", "north"] },
        "east",
        "left",
      ),
    ).state;
    expect(doubles.result?.reason).toBe("team_eliminated");
  });
});
