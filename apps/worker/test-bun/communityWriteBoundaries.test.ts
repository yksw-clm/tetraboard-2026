// 書き込み元の走査は Worker の SQL リテラルが対象です。動的な表名や組み立て後の SQL は検査しません。
import { expect, test } from "bun:test";
import { updateClauses, workerSqlWrites } from "./sqlWrites";

const boardPosting = "adapters/community/boardPosting.ts";
const boardActions = "adapters/community/boardActions.ts";
const boardDeletion = "adapters/community/boardDeletion.ts";
const boardCleanup = "adapters/community/boardCleanup.ts";
const boardModeration = "adapters/community/boardModeration.ts";
const boardReports = "adapters/community/boardReports.ts";
const guestMerge = "adapters/community/guestMergeWrites.ts";

const boundaries = {
  "INSERT board_posts": [boardPosting],
  "UPDATE board_posts": [boardActions, boardDeletion, boardDeletion, boardModeration],
  "DELETE board_posts": [],
  "INSERT board_senders": [boardPosting, boardModeration],
  "UPDATE board_senders": [boardPosting, boardModeration],
  "DELETE board_senders": [boardDeletion],
  "INSERT board_likes": [boardActions],
  "DELETE board_likes": [boardActions, boardDeletion, boardDeletion],
  "INSERT board_settings": [],
  "UPDATE board_settings": [boardModeration],
  "DELETE board_settings": [],
  "INSERT board_reports": [boardReports],
  "UPDATE board_reports": [
    boardCleanup,
    boardCleanup,
    boardDeletion,
    boardDeletion,
    boardModeration,
    boardModeration,
    guestMerge,
  ],
  "DELETE board_reports": [boardCleanup],
  "INSERT lobby_chat_messages": ["adapters/community/chatStore.ts"],
  "UPDATE lobby_chat_messages": ["adapters/community/guestMergeWrites.ts"],
  "INSERT announcements": ["adapters/community/announcements.ts"],
  "UPDATE announcements.published": ["adapters/community/announcements.ts"],
  "INSERT account_badge_notifications": [
    "adapters/record/badgeAwards.ts",
    "adapters/record/guestMergeWrites.ts",
  ],
  "UPDATE account_badge_notifications": [
    "adapters/record/badgeNotifications.ts",
    "adapters/record/badgeNotifications.ts",
  ],
  "INSERT notification_events": [
    "adapters/community/announcements.ts",
    "adapters/community/badgeEvents.ts",
    boardPosting,
    "adapters/tournament/finalization.ts",
  ],
  "UPDATE notification_events": ["adapters/community/notifications.ts"],
  "DELETE notification_events": [
    "adapters/community/notifications.ts",
    "flows/accountPurge/deletionCleanup.ts",
  ],
};

for (const [key, expected] of Object.entries(boundaries)) {
  test(`${key} は指定のファイルだけが書き込む`, () => {
    const actual = workerSqlWrites.filter((write) => {
      if (key === "UPDATE announcements.published")
        return (
          write.table === "announcements" &&
          updateClauses(write).some(({ columns }) => columns.includes("published"))
        );
      return `${write.operation} ${write.table}` === key;
    });
    expect(actual.map(({ file }) => file).sort()).toEqual([...expected].sort());
  });
}
