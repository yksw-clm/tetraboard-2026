import { fixture, move } from "./positionFixture";
import { positionForSide, getCheckState } from "../src/board";
import { applyAction, getLegalActions, getActiveSides } from "../src/index";
import { sides, type FourShogiState, type FourShogiAction, type Side } from "../src/types";

export function searchTacticalCases() {
  const families = [
    {
      id: "checking-capture-before-recapture",
      state: fixture({
        kings: { south: "E9", north: "G1", east: "D1" },
        pieces: [
          { side: "south" as const, kind: "rook" as const, at: "C4" },
          { side: "west" as const, kind: "pawn" as const, at: "G4" },
          { side: "west" as const, kind: "rook" as const, at: "I4" },
        ],
      }),
      action: move("C4", "G4"),
      criterion: "checking-capture" as const,
    },
    {
      id: "counter-check-rook-loss",
      state: fixture({
        kings: { south: "E9", west: "H3" },
        pieces: [
          { side: "south" as const, kind: "rook" as const, at: "D3" },
          { side: "west" as const, kind: "rook" as const, at: "E1" },
        ],
      }),
      action: move("D3", "E3"),
      criterion: "avoid-loss" as const,
    },
    {
      id: "poisoned-pawn-rook-loss",
      state: fixture({
        pieces: [
          { side: "south" as const, kind: "rook" as const, at: "B4" },
          { side: "west" as const, kind: "pawn" as const, at: "D4" },
          { side: "west" as const, kind: "rook" as const, at: "D8" },
        ],
      }),
      action: move("B4", "D4"),
      criterion: "avoid-loss" as const,
    },
  ];
  return families.flatMap((family) =>
    [false, true].flatMap((restricted) =>
      sides.map((orientation, offset) => {
        const rotateSide = (side: Side) => sides[(sides.indexOf(side) + offset) % 4];
        const board = family.state.board.map((row) =>
          row.map(() => null),
        ) as FourShogiState["board"][number][number][][];
        for (let y = 0; y < 9; y++)
          for (let x = 0; x < 9; x++) {
            const piece = family.state.board[y][x];
            const to = positionForSide({ x, y }, orientation);
            board[to.y][to.x] = piece ? { ...piece, side: rotateSide(piece.side) } : null;
          }
        const action = family.action;
        if (action.type !== "movePiece") throw new Error("移動局面が必要です");
        const target: FourShogiAction = {
          ...action,
          from: positionForSide(action.from, orientation),
          to: positionForSide(action.to, orientation),
        };
        const state: FourShogiState = {
          ...family.state,
          board,
          hands: Object.fromEntries(
            sides.map((side) => [rotateSide(side), family.state.hands[side]]),
          ) as FourShogiState["hands"],
          threePlayerAttackProhibited: restricted,
          status: "playing",
          turn: orientation,
          result: null,
        };
        return {
          id: `${family.id}-${restricted}-${orientation}`,
          family: family.id,
          split: "tuning" as const,
          state,
          action: target,
          criterion: family.criterion,
        };
      }),
    ),
  );
}
export function acceptsSearchTactic(
  tactic: ReturnType<typeof searchTacticalCases>[number],
  action: FourShogiAction | null,
) {
  if (action === null || tactic.state.status !== "playing") return false;
  const result = applyAction(tactic.state, tactic.state.turn, action);
  if (!result.ok) return false;
  if (tactic.criterion === "avoid-loss")
    return (
      getActiveSides(result.state).includes(tactic.state.turn) &&
      (result.state.status === "finished" ||
        getLegalActions(result.state).every((reply) => {
          const response = applyAction(result.state, result.state.turn!, reply);
          return (
            response.ok &&
            getActiveSides(response.state).includes(tactic.state.turn!) &&
            !(response.captured?.side === tactic.state.turn && response.captured.kind === "rook")
          );
        }))
    );
  const checks = getCheckState(result.state);
  return (
    result.captured !== null && sides.some((side) => side !== tactic.state.turn && checks[side])
  );
}
