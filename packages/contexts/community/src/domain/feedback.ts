import type { FeedbackPatch, FeedbackRecord } from "@tetraboard/protocol";

export const feedbackRetentionMs = 180 * 86400000;
export const feedbackRetryAfterSeconds = 600;
export const feedbackPageSize = 50;

export type FeedbackLimitIdentity = {
  reporterHash: string;
  browserHash: string;
  ipHash: string;
};

export function feedbackLimits(identity: FeedbackLimitIdentity, now: number) {
  const shortWindowMs = feedbackRetryAfterSeconds * 1000;
  const limits = [
    [identity.reporterHash, shortWindowMs, 5],
    [identity.reporterHash, 86400000, 20],
    [identity.browserHash, shortWindowMs, 5],
    [identity.browserHash, 86400000, 20],
    [identity.ipHash, shortWindowMs, 30],
  ] as const;
  return limits
    .filter(
      ([hash, span], index, all) => all.findIndex(([h, s]) => h === hash && s === span) === index,
    )
    .map(([hash, span, max]) => ({
      key: `${hash}:${span}`,
      span,
      max,
      start: Math.floor(now / span) * span,
    }));
}

export function feedbackChanges(old: FeedbackRecord, input: FeedbackPatch) {
  const next = {
    status: input.status,
    priority: input.priority,
    topicId: input.topicId,
    note: input.note,
    issueUrl: input.issueUrl,
  };
  return Object.fromEntries(
    Object.entries(next)
      .filter(([key, value]) => old[key as keyof typeof next] !== value)
      .map(([key, value]) => [key, { before: old[key as keyof typeof next], after: value }]),
  );
}

export type FeedbackCursor = { at: number; id: string };

export function feedbackPage<Row>(
  rows: Row[],
  record: (row: Row) => FeedbackRecord,
  position: (row: Row) => FeedbackCursor,
) {
  const page = rows.slice(0, feedbackPageSize);
  return {
    feedback: page.map(record),
    nextCursor: rows.length > feedbackPageSize ? position(page.at(-1)!) : null,
  };
}
