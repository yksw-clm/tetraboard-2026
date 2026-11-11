import { expect, test } from "bun:test";
import { focalStatistics, type PreliminaryGame } from "../scripts/lv6Statistics";

test("同席の同一profileを焦点席へ合算せず、席順と同率順位を保持する", () => {
  const rows: PreliminaryGame[] = [
    {
      record_type: "game",
      matchup_id: "strong",
      lineup_slots: [0, 1, 2, 3],
      error: null,
      game: {
        outcomes: [
          { color: "black", rank: 1, won: true, shared_first: true },
          { color: "white", rank: 3, won: false, shared_first: false },
          { color: "red", rank: 1, won: true, shared_first: true },
          { color: "blue", rank: 4, won: false, shared_first: false },
        ],
        moves: [
          {
            color: "black",
            decision_time_ns: 20_000_000,
            search_nodes: 200,
            trials: 20,
            mcts: { stop_reason: "deadline" },
          },
          { color: "white", decision_time_ns: 3_000_000, search_nodes: 30, trials: 3 },
          { color: "blue", decision_time_ns: 100_000_000, search_nodes: 1000, trials: 100 },
        ],
        total_time_ns: 123_000_000,
      },
    },
  ];
  const rotated = structuredClone(rows[0]);
  rotated.lineup_slots = [1, 2, 3, 0];
  rows.push(rotated);
  expect(focalStatistics(rows, 0)).toMatchObject({
    appearances: 2,
    mean_rank: 2.5,
    first_place_rate: 0.5,
    solo_first_rate: 0,
    decisions: 2,
    decision_p95_ms: 100,
    deadline_decisions: 1,
    trials: 120,
  });
  expect(focalStatistics(rows, 1)).toMatchObject({
    appearances: 2,
    mean_rank: 2,
    decisions: 2,
    decision_max_ms: 20,
    applied_moves: 230,
  });
  expect(() => focalStatistics([], 0)).toThrow();
  expect(() => focalStatistics([{ ...rows[0], error: "failed", game: null }], 0)).toThrow();
});
