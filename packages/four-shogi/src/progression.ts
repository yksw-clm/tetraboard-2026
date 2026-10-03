import { getLegalMovesWithAttacks } from "./attacks";
import { getCheckState } from "./board";
import { getOrdinaryMoves, hasOrdinaryMove } from "./moves";
import { isRepetition, recordPosition, type RepetitionLookup } from "./repetition";
import { getActiveSides, sides, teamForSide } from "./types";
import type { EliminationReason, FourShogiState, GameResult, Side } from "./types";

export function eliminateBatch(
  state: FourShogiState,
  eliminated: readonly Side[],
  reason: EliminationReason,
): FourShogiState {
  const rank =
    state.mode === "singles" ? getActiveSides(state).length - eliminated.length + 1 : null;
  const group = Math.max(0, ...state.eliminations.map((entry) => entry.group)) + 1;
  const hands = { ...state.hands };
  for (const side of eliminated) hands[side] = { rook: 0, gold: 0, silver: 0, pawn: 0 };
  return {
    ...state,
    hands,
    drawProposals: state.drawProposals.filter((side) => !eliminated.includes(side)),
    eliminations: [
      ...state.eliminations,
      ...eliminated.map((side) => ({ side, rank, group, reason })),
    ],
    attackRelations: [],
    recaptureSquares: { south: [], west: [], north: [], east: [] },
  };
}

function finish(state: FourShogiState, reason: GameResult["reason"]): FourShogiState {
  let result: GameResult;
  if (state.mode === "singles") {
    const active = getActiveSides(state);
    const standings = sides
      .map((side) => ({
        side,
        rank: active.includes(side)
          ? 1
          : state.eliminations.find((entry) => entry.side === side)!.rank!,
      }))
      .sort((left, right) => left.rank - right.rank);
    result = {
      mode: "singles",
      reason: reason as "last_player" | "no_survivors" | "repetition" | "agreement",
      standings,
    };
  } else {
    const lostTeams = new Set(state.eliminations.map((entry) => teamForSide(entry.side)));
    result = {
      mode: "doubles",
      reason: reason as "team_eliminated" | "simultaneous_mate" | "repetition" | "agreement",
      winner:
        reason === "repetition" || reason === "agreement" || lostTeams.size !== 1
          ? null
          : lostTeams.has("south-north")
            ? "west-east"
            : "south-north",
    };
  }
  return { ...state, status: "finished", turn: null, result };
}

export function finishIfDrawAgreed(state: FourShogiState): FourShogiState {
  if (state.status === "finished") return state;
  return getActiveSides(state).every((side) => state.drawProposals.includes(side))
    ? finish(state, "agreement")
    : state;
}

function finishIfEliminated(state: FourShogiState): FourShogiState {
  if (state.status === "finished") return state;
  if (state.mode === "doubles" && state.eliminations.length > 0) {
    const lostTeams = new Set(state.eliminations.map((entry) => teamForSide(entry.side)));
    return finish(state, lostTeams.size === 2 ? "simultaneous_mate" : "team_eliminated");
  }
  const remaining = getActiveSides(state).length;
  if (remaining <= 1) return finish(state, remaining === 1 ? "last_player" : "no_survivors");
  return state;
}

function nextSide(state: FourShogiState, after: Side): Side {
  const active = getActiveSides(state);
  const checks = getCheckState(state);
  const checked = active.filter((side) => checks[side]);
  const candidates = checked.length > 0 ? checked : active;
  for (let offset = 1; offset <= 4; offset++) {
    const side = sides[(sides.indexOf(after) + offset) % 4];
    if (candidates.includes(side)) return side;
  }
  throw new Error("No active side in a playing game");
}

export function settlePosition(
  input: FourShogiState,
  after: Side,
  preserveTurn = false,
  repetitionLookup?: RepetitionLookup,
): FourShogiState {
  let state = finishIfEliminated(input);
  if (state.status === "finished") return state;
  const checks = getCheckState(state);
  // 全員の応手を同じ盤面で調べ、利きを消す前に詰みの集合を確定します。
  const mated = getActiveSides(state).filter(
    (side) => checks[side] && !hasOrdinaryMove(state, side),
  );
  if (mated.length > 0) state = finishIfEliminated(eliminateBatch(state, mated, "checkmate"));
  if (state.status === "finished") return state;

  let selected =
    preserveTurn && getActiveSides(state).includes(input.turn!)
      ? input.turn!
      : nextSide(state, after);
  for (;;) {
    state = { ...state, turn: selected };
    const ordinary = getOrdinaryMoves(state, selected);
    if (getLegalMovesWithAttacks(state, selected, ordinary).length > 0) break;
    state = finishIfEliminated(eliminateBatch(state, [selected], "no_legal_actions"));
    if (state.status === "finished") return state;
    selected = nextSide(state, selected);
  }
  state = finishIfDrawAgreed(state);
  if (state.status === "finished") return state;
  const recorded = recordPosition(state, repetitionLookup);
  return isRepetition(recorded) ? finish(recorded, "repetition") : recorded;
}
