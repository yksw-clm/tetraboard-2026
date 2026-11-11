type Color = "black" | "white" | "red" | "blue";
export type PreliminaryGame = {
  record_type: "game";
  matchup_id: string;
  lineup_slots: number[];
  error: string | null;
  game: {
    outcomes: { color: Color; rank: number; won: boolean; shared_first: boolean }[];
    moves: {
      color: Color;
      decision_time_ns: number;
      search_nodes: number;
      trials: number;
      mcts?: { stop_reason: string };
    }[];
    total_time_ns: number;
  } | null;
};
const colors: Color[] = ["black", "white", "red", "blue"];

export function focalStatistics(rows: PreliminaryGame[], slot: number) {
  if (
    !rows.length ||
    rows.some(
      (r) =>
        r.error ||
        !r.game ||
        r.lineup_slots.length !== 4 ||
        new Set(r.lineup_slots).size !== 4 ||
        !r.lineup_slots.includes(slot),
    )
  )
    throw Error("完了した焦点席の対局が必要です");
  const outcomes = rows.map((r) =>
    r.game!.outcomes.find((o) => o.color === colors[r.lineup_slots.indexOf(slot)])!,
  );
  const moves = rows.flatMap((r) =>
    r.game!.moves.filter((m) => m.color === colors[r.lineup_slots.indexOf(slot)]),
  );
  const timings = moves.map((m) => m.decision_time_ns / 1e6).sort((a, b) => a - b);
  return {
    appearances: outcomes.length,
    mean_rank: outcomes.reduce((s, o) => s + o.rank, 0) / outcomes.length,
    first_place_rate: outcomes.filter((o) => o.won).length / outcomes.length,
    solo_first_rate: outcomes.filter((o) => o.won && !o.shared_first).length / outcomes.length,
    decisions: moves.length,
    decision_p95_ms: timings[Math.ceil(timings.length * 0.95) - 1],
    decision_max_ms: timings.at(-1),
    deadline_decisions: moves.filter((m) => m.mcts?.stop_reason === "deadline").length,
    applied_moves: moves.reduce((s, m) => s + m.search_nodes, 0),
    trials: moves.reduce((s, m) => s + m.trials, 0),
  };
}
