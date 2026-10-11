import {
  applyLegalPlacement,
  colors,
  countStones,
  getActiveColors,
  getLegalPlacements,
  type FourReversiState,
  type Position,
} from "./engine";
import { evaluatePosition, type PositionValues } from "./cpuEvaluation";
import { countLegalMoves, type LegalPlacement } from "./moves";
import { resolveSearchOptions, positionKey, searchCpuMove, type SearchOptions } from "./cpuSearch";

class ForecastStopped extends Error {}
const samePosition = (a: Position, b: Position) => a.x === b.x && a.y === b.y;

export function forecastCpuMove(input: FourReversiState, options: SearchOptions = {}) {
  const settings = resolveSearchOptions(options);
  if (
    !settings.policyForecast ||
    input.status === "finished" ||
    input.mode === "doubles" ||
    getActiveColors(input).length <= 2 ||
    input.board.flat().filter((cell) => cell === null).length <= settings.endgameEmpties
  )
    return searchCpuMove(input, options);

  // 終局予測が中断した場合にも、全根候補を比較済みのMaxⁿの結果を確保します。
  const normal = searchCpuMove(input, { ...options, maxWork: Math.min(settings.maxWork, 2048) });
  if (!normal.move) return normal;
  const stats = { ...normal.stats };
  const root = input.turn;
  let move = normal.move;
  const valuesCache = new Map<string, PositionValues>();
  const movesCache = new Map<string, Position>();
  function spend(cost = 1) {
    if (stats.work + cost > settings.maxWork) throw new ForecastStopped();
    stats.work += cost;
  }
  function hasCacheSpace() {
    return normal.stats.cacheEntries + valuesCache.size + movesCache.size < settings.cacheLimit;
  }
  function updateCacheSize() {
    stats.cacheEntries = normal.stats.cacheEntries + valuesCache.size + movesCache.size;
  }
  function legalMoves(state: FourReversiState) {
    const result = getLegalPlacements(state, undefined, spend);
    stats.generatedMoves += result.length;
    return result;
  }
  function advance(state: FourReversiState, legal: LegalPlacement) {
    spend();
    stats.nodes++;
    return applyLegalPlacement(state, legal, spend).state;
  }
  function policyValues(state: FourReversiState): PositionValues {
    const key = positionKey(state);
    const cached = valuesCache.get(key);
    if (cached) {
      stats.cacheHits++;
      return cached;
    }
    spend();
    const values: PositionValues = { black: 0, white: 0, red: 0, blue: 0 };
    if (state.status === "finished") {
      if (state.result.mode !== "singles") throw new Error("シングルスの応手モデルが必要です");
      for (const standing of state.result.standings)
        values[standing.color] = 10000 * (5 - standing.rank) + (standing.stoneCount ?? 0);
    } else {
      const counts = countStones(state.board);
      const mobility = countLegalMoves(state.board, getActiveColors(state), spend);
      for (const color of colors) {
        if (state.eliminatedColors.includes(color)) {
          values[color] = -10000;
          continue;
        }
        let corners = 0;
        let edges = 0;
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) {
            if (state.board[y][x] !== color) continue;
            if ((x === 0 || x === 7) && (y === 0 || y === 7)) corners++;
            else if (x === 0 || x === 7 || y === 0 || y === 7) edges++;
          }
        // 応手を予測するための短い配置評価です。通常探索の安定した辺の評価と区別します。
        values[color] = counts[color] + 25 * corners + 5 * edges + 3 * mobility[color];
      }
    }
    if (hasCacheSpace()) valuesCache.set(key, values);
    updateCacheSize();
    return values;
  }
  function policy(state: Extract<FourReversiState, { status: "playing" }>): Position {
    const key = positionKey(state);
    const cached = movesCache.get(key);
    if (cached) {
      stats.cacheHits++;
      return cached;
    }
    let best: Position | null = null;
    let bestScore = -Infinity;
    for (const legal of legalMoves(state)) {
      const next = advance(state, legal);
      let score = policyValues(next)[state.turn];
      if (next.status === "playing") {
        let bestReplyScore = -Infinity;
        for (const reply of legalMoves(next)) {
          const after = advance(next, reply);
          const values = policyValues(after);
          if (values[next.turn] > bestReplyScore) {
            bestReplyScore = values[next.turn];
            score = values[state.turn];
          }
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = legal.position;
      }
    }
    if (!best) throw new Error("エンジンが未処理のパス局面を返しました");
    if (hasCacheSpace()) movesCache.set(key, best);
    updateCacheSize();
    return best;
  }
  try {
    const candidates = legalMoves(input);
    stats.rootMoves = candidates.length;
    const preferred = policy(input);
    candidates.sort(
      (a, b) => +samePosition(b.position, preferred) - +samePosition(a.position, preferred),
    );
    let bestScore = -Infinity;
    let bestRank = Infinity;
    let normalRank = Infinity;
    let bestIndex = Infinity;
    let chosen = move;
    for (const candidate of candidates) {
      let state = advance(input, candidate);
      while (state.status === "playing") {
        const selected = policy(state);
        const legal = legalMoves(state).find((entry) => samePosition(entry.position, selected));
        if (!legal) throw new Error("応手モデルが不正な候補を返しました");
        state = advance(state, legal);
        stats.forecastPlacements++;
      }
      spend();
      const score = evaluatePosition(state)[root];
      if (state.result.mode !== "singles") throw new Error("シングルスの終局結果が必要です");
      const rank = state.result.standings.find((standing) => standing.color === root)!.rank;
      bestRank = Math.min(bestRank, rank);
      if (samePosition(candidate.position, normal.move)) normalRank = rank;
      const index = candidate.position.y * 8 + candidate.position.x;
      if (score > bestScore || (score === bestScore && index < bestIndex)) {
        bestScore = score;
        chosen = candidate.position;
        bestIndex = index;
      }
      stats.forecastRoots++;
    }
    stats.forecastCompleted = true;
    // 予測順位が同じなら通常探索を保ち、遠い将来の予測石数だけで選択を覆しません。
    if (bestRank < normalRank) {
      move = chosen;
      stats.selection = "forecast";
    }
  } catch (error) {
    if (!(error instanceof ForecastStopped)) throw error;
    stats.cutoff = true;
  }
  return { move, stats };
}
