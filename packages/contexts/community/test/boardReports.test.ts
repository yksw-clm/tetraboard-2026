import { expect, test } from "bun:test";
import { reportBoardPost, type BoardReportStore } from "../src";

const report = { accountId: "reporter", postId: "post", reason: "spam" } as const;
const now = 8 * 86400000;

test("通報の保存に報告日時・7日の期限・1時間5件の上限を渡す", async () => {
  const store: BoardReportStore = {
    async insertWithinLimit(attempt) {
      expect(attempt).toEqual({
        ...report,
        reportedAtMs: now,
        retentionCutoffMs: now - 7 * 86400000,
        rateLimitCutoffMs: now - 3600000,
        rateLimit: 5,
      });
      return true;
    },
    async hasReportSince() {
      throw new Error("挿入に成功した場合は重複を照会しません。");
    },
  };
  expect(await reportBoardPost(store, report, now)).toBe("created");
});

test.each([
  [true, "existing"],
  [false, "unavailable"],
] as const)("挿入できなければ期限内の再通報を照会する（%s）", async (exists, expected) => {
  const store: BoardReportStore = {
    async insertWithinLimit() {
      return false;
    },
    async hasReportSince(attempt, cutoff) {
      expect(attempt).toEqual(report);
      expect(cutoff).toBe(now - 7 * 86400000);
      return exists;
    },
  };
  expect(await reportBoardPost(store, report, now)).toBe(expected);
});
