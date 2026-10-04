import type { GameId } from "@tetraboard/protocol/games";
import {
  matchDataContracts,
  type MatchDataContract,
  type RecordFor,
  type StatsFor,
} from "../src/accounts/matchDataContracts";
import { gameOutcomeSql, type OutcomeSqlFor } from "../src/accounts/matchOutcomes";
declare const reversi: RecordFor<"four-reversi">;
declare const shogi: RecordFor<"four-shogi">;
declare const reversiStats: StatsFor<"four-reversi">;
declare const shogiStats: StatsFor<"four-shogi">;
// @ts-expect-error ゲーム別の保存契約登録は必須
const missing: { [G in GameId]: MatchDataContract<G> } = {
  "four-reversi": matchDataContracts["four-reversi"],
};
// @ts-expect-error 将棋の保存記録をリバーシ詳細へ渡せない
matchDataContracts["four-reversi"].detail(shogi, "", new Map());
// @ts-expect-error リバーシの保存記録を将棋棋譜へ渡せない
matchDataContracts["four-shogi"].detail(reversi, "", new Map());
// @ts-expect-error ゲーム別の集計SQL登録は必須
const missingSql: { [G in GameId]: OutcomeSqlFor<G> } = {
  "four-reversi": gameOutcomeSql["four-reversi"],
};
// @ts-expect-error 将棋の集計契約をリバーシへ登録できない
const wrongSql: OutcomeSqlFor<"four-reversi"> = gameOutcomeSql["four-shogi"];
// @ts-expect-error 将棋の戦績には撃破数が必須
const wrongShogiStats: StatsFor<"four-shogi"> = reversiStats;
// @ts-expect-error リバーシの戦績に撃破数を混ぜない
const wrongReversiStats: StatsFor<"four-reversi"> = shogiStats;
// @ts-expect-error 将棋の読取り・公開棋譜契約をリバーシへ登録できない
const wrongReader: MatchDataContract<"four-reversi"> = matchDataContracts["four-shogi"];
void [missing, missingSql, wrongSql, wrongShogiStats, wrongReversiStats, wrongReader];
