import type { GameId } from "@tetraboard/protocol/games";
import {
  matchDataContracts,
  type MatchDataContract,
  type RecordFor,
  type StatsFor,
} from "../src/adapters/record/matchDataContracts";
import { gameOutcomeSql, type OutcomeSqlFor } from "../src/adapters/record/matchOutcomes";
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

import type { StoredRecord } from "../src/adapters/record/eventRecord";
import {
  matchDetail,
  type DecodedMatch,
  type ReplayedMatch,
} from "../src/adapters/record/matchDataContracts";
declare const storedReversi: StoredRecord<RecordFor<"four-reversi">>;
// @ts-expect-error D1の本体には再生後のstepsが必要な棋譜を渡せない
const wrongStored: StoredRecord<RecordFor<"four-reversi">> = reversi;
// @ts-expect-error イベントを再生する前のD1本体を完全な棋譜として扱えない
const wrongReplayed: RecordFor<"four-reversi"> = storedReversi;
declare const stored: DecodedMatch;
// @ts-expect-error 詳細の応答を作る前にD1のイベントを再生する必要がある
matchDetail(stored, "", new Map());
declare const replayed: ReplayedMatch;
matchDetail(replayed, "", new Map());
void [wrongStored, wrongReplayed];
