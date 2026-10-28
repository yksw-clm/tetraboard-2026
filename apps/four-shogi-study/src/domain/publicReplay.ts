import { isDeepStrictEqual } from "node:util";
import {
  getPublicMatchContract,
  getPublicMatchReplayContract,
  isFourShogiMatch,
} from "@tetraboard/protocol";
import {
  analysisRuleProfileId,
  restoreAnalysisPosition,
  validateAnalysisReplay,
  type AnalysisReplayInput,
} from "@tetraboard/four-shogi/analysis";
import { StudyInputError } from "./study";

/** 公開APIの全ページを結合し、最終完全状態を公開された終局状態と照合します。 */
export async function validatePublicReplay(
  detail: unknown,
  rawPages: readonly unknown[],
): Promise<AnalysisReplayInput> {
  const { match } = getPublicMatchContract.response.parse(
    detail && typeof detail === "object" && "match" in detail ? detail : { match: detail },
  );
  if (!isFourShogiMatch(match)) throw new StudyInputError("四人将棋の公開棋譜を指定してください");
  if (match.replay.initial.mode !== "singles")
    throw new StudyInputError("シングルスの棋譜だけを読み込めます");
  if (rawPages.length === 0 || rawPages.length > 200 || match.replay.eventCount > 20000)
    throw new StudyInputError("棋譜のページ数・イベント数が不正です");
  const events: { index: number; event: unknown }[] = [];
  for (const [pageIndex, raw] of rawPages.entries()) {
    const page = getPublicMatchReplayContract.response.parse(raw);
    if (
      page.matchId !== match.id ||
      page.rulesVersion !== match.replay.rulesVersion ||
      page.eventCount !== match.replay.eventCount ||
      !isDeepStrictEqual(page.initial, match.replay.initial)
    )
      throw new StudyInputError("棋譜ページの対局・初期条件が一致しません");
    for (const entry of page.events) {
      if (entry.index !== events.length)
        throw new StudyInputError("棋譜イベントに欠落・重複・順序違いがあります");
      events.push(entry);
    }
    const last = pageIndex === rawPages.length - 1;
    if (
      last
        ? page.nextCursor !== null
        : page.events.length === 0 || page.nextCursor !== events.length
    )
      throw new StudyInputError("棋譜ページの続きが欠落または重複しています");
  }
  if (events.length !== match.replay.eventCount)
    throw new StudyInputError("棋譜イベント数が一致しません");
  const replay = validateAnalysisReplay({
    schemaVersion: 1,
    ruleProfileId: analysisRuleProfileId,
    rulesVersion: 1,
    initial: match.replay.initial,
    events,
  });
  const position = await restoreAnalysisPosition(replay);
  const { repetitions: _repetitions, ...publicState } = position.state;
  if (!isDeepStrictEqual(publicState, match.game))
    throw new StudyInputError("棋譜の再生結果と公開された終局局面が一致しません");
  return replay;
}
