export { nextDueRoomDeadline, type DueRoomDeadline } from "../use-cases/dueDeadline";

/** 過去の候補も補正せず返す。候補収集・Alarm I/Oは呼び出し側が担当する。 */
export function earliestAlarmAt(candidates: readonly number[]): number | null {
  return candidates.length === 0 ? null : Math.min(...candidates);
}
