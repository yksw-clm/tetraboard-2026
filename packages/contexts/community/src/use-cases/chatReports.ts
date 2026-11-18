import { chatRetentionCutoff, type ChatScope } from "../domain/chat";

const reportWindowMs = 3600000;
const reportLimit = 5;

export type ChatReport = { accountId: string; messageId: string; tournamentId: ChatScope };
export type ChatReportAttempt = ChatReport & {
  reportedAtMs: number;
  retentionCutoffMs: number;
  rateLimitCutoffMs: number;
  rateLimit: number;
};

export interface ChatReportStore {
  // 上限の照合と挿入を同時に行います。
  insertWithinLimit(attempt: ChatReportAttempt): Promise<boolean>;
  hasReportSince(report: ChatReport, cutoffMs: number): Promise<boolean>;
}

export async function reportChatMessage(store: ChatReportStore, report: ChatReport, now: number) {
  const retentionCutoffMs = chatRetentionCutoff(now);
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
