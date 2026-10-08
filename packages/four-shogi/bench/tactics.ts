import { applyAction, getLegalActions, getActiveSides, getCheckState } from "../src/index";
import { positionForSide } from "../src/board";
import {
  sides,
  teamForSide,
  type Side,
  type FourShogiState,
  type FourShogiAction,
} from "../src/types";
import { fixture, type FixtureOptions } from "./positionFixture";

type Criterion = "rook" | "promotion" | "block" | "win" | "safe" | "cooperate" | "magic";
type Family = {
  id: string;
  criterion: Criterion;
  critical?: boolean;
  setup: FixtureOptions;
  proof: string;
};
const families: Family[] = [
  {
    id: "free-rook",
    criterion: "rook",
    setup: {
      pieces: [
        { side: "south", kind: "silver", at: "E5" },
        { side: "west", kind: "pawn", at: "D4" },
        { side: "west", kind: "rook", at: "F4" },
      ],
    },
    proof: "E5銀はF4飛車とD4歩を取れ、飛車取りに即時の取り返しがない。",
  },
  {
    id: "poisoned-gold",
    criterion: "promotion",
    setup: {
      kings: { north: "I2" },
      pieces: [
        { side: "south", kind: "rook", at: "E5" },
        { side: "west", kind: "gold", at: "D5" },
        { side: "west", kind: "pawn", at: "E3" },
        { side: "west", kind: "rook", at: "D1" },
      ],
    },
    proof: "D5金取りはD1飛車に取り返される。E3歩取りと成りは駒を失わず収穫できる。",
  },
  {
    id: "pawn-promotion",
    criterion: "promotion",
    setup: { pieces: [{ side: "south", kind: "pawn", at: "E4" }] },
    proof: "E4歩は安全にE3へ成れる。",
  },
  {
    id: "forced-block",
    criterion: "block",
    critical: true,
    setup: {
      kings: { south: "E9", north: "I2", east: "I7" },
      pieces: [
        { side: "west", kind: "rook", at: "E1" },
        { side: "south", kind: "pawn", at: "D8" },
        { side: "south", kind: "pawn", at: "F8" },
        { side: "south", kind: "rook", at: "D9" },
        { side: "south", kind: "rook", at: "F9" },
      ],
      hands: { south: { gold: 1 } },
    },
    proof: "E1飛車の王手。玉の退路は自駒で塞がり、持ち金の合駒だけが合法な応手。",
  },
  {
    id: "last-opponent",
    criterion: "win",
    critical: true,
    setup: {
      kings: { west: "E1" },
      pieces: [
        { side: "south", kind: "rook", at: "D3" },
        { side: "south", kind: "rook", at: "F3" },
        { side: "south", kind: "silver", at: "E3" },
        { side: "south", kind: "rook", at: "G2" },
        { side: "west", kind: "rook", at: "G5" },
      ],
      eliminations: [
        { side: "north", reason: "left", rank: 4, group: 1 },
        { side: "east", reason: "left", rank: 3, group: 2 },
      ],
    },
    proof: "D3・F3飛車とE3銀で退路を塞ぎ、一手で残る敵王を詰ませられる。",
  },
  {
    id: "doubles-mate",
    criterion: "win",
    critical: true,
    setup: {
      mode: "doubles",
      kings: { south: "E9", west: "A1", north: "I9", east: "I1" },
      pieces: [
        { side: "south", kind: "rook", at: "E2" },
        { side: "south", kind: "gold", at: "B3" },
        { side: "south", kind: "gold", at: "H3" },
      ],
    },
    proof: "E1飛車で両敵王の退路を金で塞ぎ、チーム勝利を確定できる。",
  },
  {
    id: "ally-recapture",
    criterion: "cooperate",
    setup: {
      mode: "doubles",
      kings: { south: "A8", north: "E1" },
      pieces: [
        { side: "west", kind: "rook", at: "E9" },
        { side: "south", kind: "gold", at: "E5" },
        { side: "west", kind: "gold", at: "C2" },
        { side: "west", kind: "gold", at: "F2" },
        { side: "east", kind: "gold", at: "G3" },
        { side: "west", kind: "rook", promoted: true, at: "D4" },
        { side: "north", kind: "rook", at: "B9" },
      ],
    },
    proof: "E5金でD4龍を取ると味方への空き王手が生じるが、B9飛車のE9取りが合法な応手となる。",
  },
  {
    id: "later-enemy-mate",
    criterion: "safe",
    critical: true,
    setup: {
      kings: { north: "E1", east: "E7" },
      pieces: [
        { side: "south", kind: "rook", at: "H5" },
        { side: "south", kind: "pawn", at: "A8" },
        { side: "west", kind: "rook", at: "A5" },
        { side: "west", kind: "rook", at: "F5" },
        { side: "west", kind: "gold", at: "C8" },
        { side: "east", kind: "gold", at: "B7" },
        { side: "east", kind: "gold", at: "C9" },
      ],
    },
    proof: "F5飛車取りは次の西のA8飛車で即詰み。北・東への王手で西の手番を飛ばせる。",
  },
  {
    id: "inactive-rook",
    criterion: "rook",
    setup: {
      pieces: [
        { side: "south", kind: "silver", at: "E5" },
        { side: "west", kind: "rook", at: "F4" },
      ],
      eliminations: [{ side: "west", reason: "left", rank: 4, group: 1 }],
    },
    proof: "脱落した西の飛車には利きがなく、F4銀取りで持ち駒にできる。",
  },
  {
    id: "east-rook",
    criterion: "rook",
    setup: {
      pieces: [
        { side: "south", kind: "silver", at: "E3" },
        { side: "east", kind: "rook", at: "F2" },
        { side: "west", kind: "pawn", at: "D2" },
      ],
    },
    proof: "E3銀はF2飛車を成って取れ、D2歩取りより大きい安全な収穫となる。",
  },
  {
    id: "forced-promotion",
    criterion: "promotion",
    critical: true,
    setup: { pieces: [{ side: "south", kind: "pawn", at: "E2" }] },
    proof: "E1への歩の前進は成り必須。周辺に捕獲できる敵駒はない。",
  },
  {
    id: "magic-recapture",
    criterion: "magic",
    setup: {
      kings: { south: "A8", east: "I5" },
      pieces: [
        { side: "south", kind: "rook", at: "E5" },
        { side: "west", kind: "rook", at: "C5" },
        { side: "west", kind: "rook", at: "C9" },
        { side: "north", kind: "gold", at: "C4" },
      ],
    },
    proof:
      "E5飛車でC5飛車を取ると東I5王へ王手。西C9飛車の取り返し前に東が応じ、南へ手番が戻る。東I4玉にはC4金取りの連続王手がある。",
  },
  {
    id: "gold-rook",
    criterion: "rook",
    setup: {
      pieces: [
        { side: "south", kind: "gold", at: "D5" },
        { side: "north", kind: "rook", at: "D4" },
        { side: "east", kind: "pawn", at: "C4" },
      ],
    },
    proof: "D5金はD4飛車とC4歩を取れ、D4飛車取りに即時の取り返しがない。",
  },
];

export type TacticCase = {
  id: string;
  family: string;
  split: "regression" | "validation";
  state: FourShogiState;
  criterion: Criterion;
  critical: boolean;
  proof: string;
};

export function tacticalCases(): TacticCase[] {
  return families.flatMap((family, index) =>
    [false, true].flatMap((restricted) =>
      sides.map((orientation, offset) => {
        const base = fixture({ ...family.setup, threePlayerAttackProhibited: restricted });
        const rotateSide = (side: Side) => sides[(sides.indexOf(side) + offset) % 4];
        const board = base.board.map((row) =>
          row.map(() => null),
        ) as FourShogiState["board"][number][number][][];
        for (let y = 0; y < 9; y++)
          for (let x = 0; x < 9; x++) {
            const piece = base.board[y][x];
            const to = positionForSide({ x, y }, orientation);
            board[to.y][to.x] = piece ? { ...piece, side: rotateSide(piece.side) } : null;
          }
        const hands = Object.fromEntries(
          sides.map((side) => [rotateSide(side), base.hands[side]]),
        ) as FourShogiState["hands"];
        const state: FourShogiState = {
          ...base,
          status: "playing",
          turn: rotateSide("south"),
          result: null,
          board,
          hands,
          eliminations: base.eliminations.map((entry) => ({
            ...entry,
            side: rotateSide(entry.side),
          })),
        };
        return {
          id: `${family.id}-${restricted}-${orientation}`,
          family: family.id,
          split: index >= 9 ? "validation" : "regression",
          state,
          criterion: family.criterion,
          critical: family.critical ?? false,
          proof: family.proof,
        };
      }),
    ),
  );
}

export function acceptsTactic(tactic: TacticCase, action: FourShogiAction | null): boolean {
  if (!action || tactic.state.status !== "playing") return false;
  const root = tactic.state.turn;
  const result = applyAction(tactic.state, root, action);
  if (!result.ok) return false;
  const after = result.state;
  switch (tactic.criterion) {
    case "rook":
      return result.captured?.kind === "rook";
    case "promotion":
      return action.type === "movePiece" && action.promote;
    case "block":
      return action.type === "dropPiece" && !getCheckState(after)[root];
    case "win":
      return (
        after.status === "finished" &&
        (after.result.mode === "singles"
          ? after.result.reason === "last_player" &&
            after.result.standings.some((entry) => entry.side === root && entry.rank === 1)
          : after.result.winner === teamForSide(root))
      );
    case "cooperate":
      return (
        result.captured?.promoted === true &&
        after.status === "playing" &&
        teamForSide(after.turn) === teamForSide(root) &&
        getLegalActions(after).some((reply) => {
          const response = applyAction(after, after.turn, reply);
          return (
            response.ok && response.captured?.kind === "rook" && response.state.status === "playing"
          );
        })
      );
    case "safe":
      return (
        getActiveSides(after).includes(root) &&
        after.status === "playing" &&
        getLegalActions(after).every((reply) => {
          const response = applyAction(after, after.turn, reply);
          return response.ok && getActiveSides(response.state).includes(root);
        })
      );
    case "magic":
      return (
        result.captured?.kind === "rook" &&
        after.status === "playing" &&
        getCheckState(after)[after.turn] &&
        getLegalActions(after).every((reply) => {
          const response = applyAction(after, after.turn, reply);
          return response.ok && response.state.status === "playing" && response.state.turn === root;
        })
      );
  }
}
