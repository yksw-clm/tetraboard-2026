import { expect, test } from "bun:test";
import { hasRequiredWhereTerms, updateClauses, workerSqlWrites } from "./sqlWrites";

const notifications = "adapters/community/notifications.ts";
const announcements = "adapters/community/announcements.ts";
const badgeAwards = "adapters/record/badgeAwards.ts";
const guestMerge = "adapters/record/guestMergeWrites.ts";
const matchClaims = "adapters/record/matchClaimStore.ts";
const publication = "adapters/record/publication.ts";
const boundAccount = '${accountNotDeletedSql("?1")}';
const currentClaimAccount = '${accountNotDeletedSql("match_participant_accounts.account_id")}';
const replayAccount =
  "${accountNotDeletedSql(mergedAccountIdSql(\"json_extract(p.value, '$.accountId')\"))}";
const deletionGuard = "${guard.sql}";

const boundaries: Record<string, [file: string, ...terms: string[]][]> = {
  "INSERT feedback": [["adapters/community/feedbackSubmission.ts", boundAccount]],
  "INSERT account_notification_reads": [
    [notifications, boundAccount],
    [notifications, boundAccount],
    [notifications, boundAccount],
  ],
  "INSERT account_notification_state": [
    [notifications, boundAccount],
    [notifications, boundAccount],
  ],
  "INSERT notification_events": [
    [announcements, "a . published = 1"],
    ["adapters/community/badgeEvents.ts", '${accountNotDeletedSql("awards.account_id")}'],
    ["adapters/tournament/finalization.ts", '${notificationRecipientAllowedSql("?2")}'],
  ],
  "UPDATE notification_events": [[notifications, '${notificationRecipientAllowedSql("?1")}']],
  "INSERT account_badge_awards": [
    [badgeAwards, '${accountNotDeletedSql("v.account_id")}'],
    [guestMerge, boundAccount],
  ],
  "INSERT account_badge_notifications": [
    [badgeAwards, '${accountNotDeletedSql("account_badge_awards.account_id")}'],
    [guestMerge, boundAccount],
  ],
  "INSERT account_match_history": [
    [publication, replayAccount],
    [publication, replayAccount],
    [matchClaims, '${accountNotDeletedSql(mergedAccountIdSql("c.account_id"))}'],
  ],
  "INSERT match_participant_accounts": [[matchClaims, '${accountNotDeletedSql("user.id")}']],
  "UPDATE match_participant_accounts": [
    [matchClaims, currentClaimAccount],
    [matchClaims, currentClaimAccount],
    [matchClaims, "account_id = ? 1", deletionGuard],
    [guestMerge, boundAccount],
  ],
};

for (const [key, expected] of Object.entries(boundaries)) {
  test(`${key} は指定の入口と必須の WHERE 条件を使います`, () => {
    const writes = workerSqlWrites.filter(
      ({ operation, table }) => `${operation} ${table}` === key,
    );
    expect(writes.map(({ file }) => file).sort()).toEqual(expected.map(([file]) => file).sort());
    const remaining = [...writes];
    for (const [file, ...terms] of expected) {
      const index = remaining.findIndex(
        (write) => write.file === file && hasRequiredWhereTerms(write, ...terms),
      );
      expect(
        index,
        `${file} の ${key} の WHERE に必須の AND 項 (${terms.join(", ")}) が必要です`,
      ).not.toBe(-1);
      remaining.splice(index, 1);
    }
    // 更新にも退会フェンスがある表は、INSERT の UPSERT で更新を迂回させません。
    if (key === "INSERT notification_events" || key === "INSERT match_participant_accounts")
      for (const write of writes) expect(updateClauses(write)).toEqual([]);
  });
}

test("全体通知は空の宛先で保存し、退会処理で引き継ぎを失効させるときは本人参照を NULL にします", () => {
  const announcement = workerSqlWrites.find(
    ({ file, table, operation }) =>
      file === announcements && table === "notification_events" && operation === "INSERT",
  );
  expect(announcement?.sql).toMatch(
    /notification_events\(kind,source_id,account_id,created_at_ms\) SELECT 'announcement',a\.id,'',a\.updated_at_ms FROM announcements\b/,
  );
  const retirement = workerSqlWrites.find(
    (write) =>
      write.file === matchClaims &&
      write.table === "match_participant_accounts" &&
      write.operation === "UPDATE" &&
      hasRequiredWhereTerms(write, "account_id = ? 1", deletionGuard),
  );
  expect(retirement?.sql).toMatch(/\bSET state='retired',account_id=NULL WHERE\b/);
});
