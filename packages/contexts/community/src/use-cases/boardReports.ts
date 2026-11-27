import type { BoardReportReason } from "@tetraboard/protocol/board";
import { chatRetentionCutoff as boardReportRetentionCutoff } from "../domain/chat";
import { reportLimit, reportWindowMs } from "./reportLimits";

export { boardReportRetentionCutoff };

export type BoardReport = { accountId: string; postId: string; reason: BoardReportReason };
export type BoardReportAttempt = BoardReport & {
  reportedAtMs: number;
  retentionCutoffMs: number;
  rateLimitCutoffMs: number;
  rateLimit: number;
};

export interface BoardReportStore {
  insertWithinLimit(attempt: BoardReportAttempt): Promise<boolean>;
  hasReportSince(report: BoardReport, cutoffMs: number): Promise<boolean>;
}

export async function reportBoardPost(store: BoardReportStore, report: BoardReport, now: number) {
  const retentionCutoffMs = boardReportRetentionCutoff(now);
  const inserted = await store.insertWithinLimit({
    ...report,
    reportedAtMs: now,
    retentionCutoffMs,
    rateLimitCutoffMs: now - reportWindowMs,
    rateLimit: reportLimit,
  });
  if (inserted) return "created";
  return (await store.hasReportSince(report, retentionCutoffMs)) ? "existing" : "unavailable";
}
