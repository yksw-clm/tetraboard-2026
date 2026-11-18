import { expect, test } from "bun:test";
import { reportChatMessage } from "../src";

const report = { accountId: "reporter", messageId: "message", tournamentId: 42 };
const now = 8 * 86400000;

test("直近1時間に5件の条件で通報を挿入し、受理できたら重複を照会しない", async () => {
  const result = await reportChatMessage(
    {
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
    },
    report,
    now,
  );

  expect(result).toBe("created");
});

test.each([
  { existing: true, status: "existing" },
  { existing: false, status: "unavailable" },
])("挿入できなければ保持期間内の同じ通報を照合し $status を返す", async ({ existing, status }) => {
  const result = await reportChatMessage(
    {
      async insertWithinLimit() {
        return false;
      },
      async hasReportSince(query, cutoffMs) {
        expect(query).toEqual(report);
        expect(cutoffMs).toBe(now - 7 * 86400000);
        return existing;
      },
    },
    report,
    now,
  );

  expect(result).toBe(status);
});
