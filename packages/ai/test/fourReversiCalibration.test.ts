import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCalibrationUnit } from "../scripts/fourReversiCalibrationStatistics";

test("較正の完了単位は全席順を検査し、重複・途中ログ・失敗を集計対象から外す", async () => {
  const directory = await mkdtemp(join(tmpdir(), "four-reversi-calibration-test-"));
  const path = join(directory, "unit.jsonl");
  const colors = ["black", "white", "red", "blue"];
  const lineup = ["a", "b", "b", "c"];
  const matchup = { id: "sample", lineup };
  const rows = colors.map((_, rotation) => {
    const slots = colors.map((_, i) => (i + rotation) % 4);
    return {
      record_type: "game",
      matchup_id: matchup.id,
      lineup_slots: slots,
      profile_ids: slots.map((slot) => lineup[slot]),
      error: null,
      game: { outcomes: colors.map((color, i) => ({ color, rank: [1, 1, 3, 4][i], score: 0 })) },
    };
  });
  const summary = { record_type: "summary", seed: 2_000_000, completed_games: 4, failed_games: 0 };
  const write = (items: unknown[]) =>
    Bun.write(path, items.map((item) => JSON.stringify(item)).join("\n"));
  const read = () => readCalibrationUnit(path, summary.seed, [matchup], 4);
  try {
    await write([...rows, summary]);
    expect((await read())[0]?.outcomes.map((outcome) => outcome.rank)).toEqual([1, 1, 3, 4]);
    for (const invalid of [
      rows,
      [...rows.slice(1), rows[1], summary],
      [...rows, { ...summary, completed_games: 3, failed_games: 1 }],
    ]) {
      await write(invalid);
      await expect(read()).rejects.toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
