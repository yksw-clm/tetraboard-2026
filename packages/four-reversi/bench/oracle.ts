import {
  applyAction,
  colors,
  getLegalMoves,
  type Color,
  type FourReversiState,
  type Position,
} from "../src/index";
import { team } from "./measurement";

type Values = Record<Color, number>;

// 候補AIの評価・探索・キャッシュを使わず、確定ルールの終局結果を全列挙します。
function terminal(state: FourReversiState): Values {
  if (state.status !== "finished") throw new Error("oracleの終局評価へ進行局面を渡しました");
  const scores: Values = { black: 0, white: 0, red: 0, blue: 0 };
  if (state.result.mode === "singles") {
    for (const entry of state.result.standings)
      scores[entry.color] = (2 - entry.rank) * 1_000_000 + (entry.stoneCount ?? 0);
  } else {
    const totals = state.result.teamTotals;
    for (const color of colors) {
      const own = team(color);
      const other = own === "black-red" ? "white-blue" : "black-red";
      scores[color] =
        (state.result.winner === null ? 0 : state.result.winner === own ? 1_000_000 : -1_000_000) +
        (totals ? totals[own] - totals[other] : 0);
    }
  }
  return scores;
}

export function solveEndgame(input: FourReversiState): {
  moves: Position[];
  values: Values;
  nodes: number;
} {
  if (input.status !== "playing") return { moves: [], values: terminal(input), nodes: 0 };
  if (input.board.flat().filter((cell) => cell === null).length > 6)
    throw new Error("oracleは空き6マス以下に限定します");
  const root = input.turn;
  const maxn = input.mode === "singles" && input.eliminatedColors.length < 2;
  let nodes = 0;
  function visit(state: FourReversiState): Values {
    nodes++;
    if (state.status === "finished") return terminal(state);
    let best: Values | null = null;
    const maximizing =
      state.mode === "singles" ? state.turn === root : team(state.turn) === team(root);
    for (const position of getLegalMoves(state)) {
      const applied = applyAction(state, { type: "placeStone", position });
      if (!applied.ok) throw new Error("oracleの合法候補が拒否されました");
      const values = visit(applied.state);
      const better = maxn
        ? best === null || values[state.turn] > best[state.turn]
        : best === null || (maximizing ? values[root] > best[root] : values[root] < best[root]);
      if (better) best = values;
    }
    if (!best) throw new Error("oracleに未処理のパス局面があります");
    return best;
  }
  let best: Values | null = null;
  const choices: Position[] = [];
  for (const position of getLegalMoves(input)) {
    const applied = applyAction(input, { type: "placeStone", position });
    if (!applied.ok) throw new Error("oracleの根候補が拒否されました");
    const values = visit(applied.state);
    if (!best || values[root] > best[root]) {
      best = values;
      choices.length = 0;
      choices.push(position);
    } else if (values[root] === best[root]) choices.push(position);
  }
  if (!best) throw new Error("oracleの根に合法手がありません");
  return { moves: choices, values: best, nodes };
}
