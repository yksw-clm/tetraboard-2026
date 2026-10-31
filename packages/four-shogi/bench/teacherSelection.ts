import {
  advanceAnalysisPosition,
  restoreAnalysisPosition,
  type AnalysisReplayInput,
} from "../src/analysis";
import { getCheckState } from "../src/board";
import { getActiveSides } from "../src/types";
import type { GameArtifact } from "./selfPlayData";

export const trajectoryTeacherVersion = "trajectory-importance-v1" as const;
export type TeacherPoint = {
  index: number;
  priority: number;
  alive: number;
  checked: boolean;
  capture: boolean;
  promotion: boolean;
  elimination: boolean;
};

/** 三つの時期ごとに半数を時系列の錨、残りを確定した戦術事象へ割り当てる。 */
export function selectTrajectoryPoints(points: readonly TeacherPoint[], limit: number): number[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 256)
    throw new Error("教師件数が不正です");
  if (!points.length || limit === 0) return [];
  const count = Math.min(limit, points.length),
    selected = new Set<number>();
  for (let bin = 0; bin < 3; bin++) {
    const entries = points.filter(
      (_, i) => Math.min(2, Math.floor((i * 3) / points.length)) === bin,
    );
    const quota = Math.min(entries.length, Math.floor(count / 3) + Number(bin < count % 3));
    const anchors = Math.ceil(quota / 2);
    for (let i = 0; i < anchors; i++) {
      const index =
        anchors === 1 ? entries.length - 1 : Math.round((i * (entries.length - 1)) / (anchors - 1));
      selected.add(entries[index].index);
    }
    for (const entry of [...entries].sort((a, b) => b.priority - a.priority || a.index - b.index)) {
      if (entries.filter((p) => selected.has(p.index)).length >= quota) break;
      selected.add(entry.index);
    }
  }
  // 非常に短い棋譜でも最終着手直前を残す。採点や勝敗ラベルは参照しない。
  const last = points.at(-1)!.index;
  if (!selected.has(last)) {
    if (selected.size >= count) selected.delete([...selected].at(-1)!);
    selected.add(last);
  }
  for (const p of [...points].sort((a, b) => b.priority - a.priority || a.index - b.index)) {
    if (selected.size >= count) break;
    selected.add(p.index);
  }
  return [...selected].sort((a, b) => a - b);
}

/** 盤面だけで再構成せず、元の攻撃/反復履歴を含む正本で全イベントを再生する。 */
export async function trajectoryTeacherPoints(
  origin: AnalysisReplayInput,
  record: Pick<GameArtifact, "actors" | "replay" | "openingEventCount">,
  limit: number,
  signal?: AbortSignal,
) {
  let position = await restoreAnalysisPosition(origin);
  const points: TeacherPoint[] = [];
  for (let index = 0; index < record.actors.length; index++) {
    if (signal?.aborted) throw new Error("局面選別を中断しました");
    const event = record.replay.events[record.openingEventCount + index].event;
    if (event.type !== "action" || position.state.status !== "playing")
      throw new Error("確定棋譜の着手列が不正です");
    const checked = getCheckState(position.state)[position.state.turn!],
      alive = getActiveSides(position.state).length;
    const next = await advanceAnalysisPosition(position, event);
    const capture = Boolean(next.state.lastMove?.captured),
      promotion = event.action.type === "movePiece" && event.action.promote;
    const elimination = getActiveSides(next.state).length < alive;
    points.push({
      index,
      alive,
      checked,
      capture,
      promotion,
      elimination,
      priority:
        Number(elimination) * 1000 +
        Number(checked) * 100 +
        Number(promotion) * 10 +
        Number(capture),
    });
    position = next;
  }
  return { points, indices: selectTrajectoryPoints(points, limit) };
}
