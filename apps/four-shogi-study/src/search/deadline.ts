export type StudyLifecycleEvent = {
  clock: "parent-monotonic";
  stage: string;
  id: string | null;
  atMs: number;
  durationMs?: number;
  reason?: string;
};

/** 終了処理の余裕を予約します。同期処理やOSの遅延に対する実時間保証ではありません。 */
export function createStudyDeadline(budgetMs: number, workDeadlineAt?: number) {
  const startedAt = performance.now();
  const endsAt = startedAt + budgetMs;
  const settlementMs = Math.min(100, budgetMs * 0.05);
  return {
    startedAt,
    endsAt,
    settlementMs,
    workUntil: Math.min(endsAt, workDeadlineAt ?? endsAt - settlementMs),
  };
}
