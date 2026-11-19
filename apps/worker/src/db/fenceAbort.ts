type FenceAbortCode =
  | "account_busy"
  | "account_deleted"
  | "guest_merge_conflict"
  | "guest_promotion_conflict"
  | "guest_merged"
  | "registration account deleted";

type Rejection = {
  when: string;
  values?: (string | number | null)[];
  code: FenceAbortCode;
};

// SQLite は無効な JSON パスをエラーに含めます。固定の拒否理由をパスに使い、
// 条件に一致したときだけ D1 の batch 全体を取り消します。
export function prepareFenceAbort(db: D1Database, ...rejections: Rejection[]) {
  return db
    .prepare(
      `SELECT CASE ${rejections.map(({ when }) => `WHEN ${when} THEN json_extract('{}', ?)`).join(" ")} END`,
    )
    .bind(...rejections.flatMap(({ values, code }) => [...(values ?? []), code]));
}
