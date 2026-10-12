import data from "../test/fixtures/lv3Positions.json";
import type { FourShogiState } from "../src/types";
// 共通の履歴キーを復元し、本番と同じ千日手履歴を検証に渡します。
export const lv3Fixtures = data.positions.map((fixture) => ({
  ...fixture,
  state: {
    ...fixture.state,
    repetitions: Object.fromEntries(
      fixture.repetitionCounts.map(([key, count]) => [data.historyKeys[key], count]),
    ),
  } as unknown as FourShogiState,
}));
