import { expect, test } from "bun:test";
import {
  hasRequiredWhereTerms,
  hasSqlCondition,
  updateClauses,
  workerSqlWrites,
} from "./sqlWrites";

const linkWrites = "adapters/account/guestLinkWrites.ts";
const registrationWrites = "adapters/account/registrationWrites.ts";

const registrationGuard = '${registrationAccountAllowed("?")}';

const boundaries: Record<string, [file: string, ...terms: string[]][]> = {
  "INSERT guest_account_merges": [[linkWrites, "${mergeFence}"]],
  "INSERT guest_promotions": [[linkWrites, "${promotionFence}"]],
  "INSERT guest_room_link_commits": [[linkWrites, "${roomLinkFence}"]],
  "INSERT registration_flows": [
    [registrationWrites, '${registrationAccountAllowed("candidate.account_id")}'],
  ],
  "INSERT account_room_seats": [
    ["adapters/matchmaking/seatWrites.ts", "${fence.sql}"],
    ["adapters/room/seatReservations.ts", "${fence.sql}"],
    ["adapters/tournament/seatWrites.ts", "${fence.sql}"],
  ],
  "INSERT tournament_wait_reservations": [
    ["adapters/tournament/queue.ts", "${fence.sql}"],
    ["adapters/tournament/queue.ts", "${fence.sql}"],
  ],
  "INSERT tournament_entries": [
    ["adapters/tournament/entries.ts", 'NOT ${guestMerged("user.id")}'],
  ],
  "UPDATE guest_account_merges": [],
  "UPDATE guest_promotions": [],
  "UPDATE guest_room_link_commits": [],
  "UPDATE registration_flows": [
    [linkWrites, registrationGuard],
    [linkWrites, "id = ?", "account_id = ?"],
    ["adapters/account/guestLinks.ts", registrationGuard],
    [
      "adapters/account/guestLinks.ts",
      "id = ?",
      "NOT EXISTS ( SELECT 1 FROM guest_account_merges WHERE guest_id = registration_flows . guest_account_id )",
    ],
    ["adapters/account/registrations.ts", registrationGuard],
    ...Array.from({ length: 7 }, (): [string, string] => [registrationWrites, "id = ?"]),
  ],
  "UPDATE account_room_seats": [
    [
      "adapters/account/registrationSeats.ts",
      "account_id = ?",
      "room_id = ?",
      "instance_id = ?",
      "player_id = ?",
    ],
    ["adapters/room/guestMergeWrites.ts", "account_id = ?", "room_id = ?"],
    ["adapters/room/seatReservations.ts", "account_id = ?", "operation_id = ?"],
  ],
  "UPDATE tournament_wait_reservations": [
    ["adapters/tournament/groupWrites.ts", "account_id = ?", "operation_id = ?"],
    ["adapters/tournament/queue.ts", "account_id = ?", "operation_id = ?"],
    ["adapters/tournament/seatWrites.ts", "account_id = ?", "operation_id = ?"],
  ],
  "UPDATE tournament_entries": [
    ["adapters/tournament/guestMergeWrites.ts", "account_id = ?"],
    [
      "flows/accountPurge/requestDeletion.ts",
      "account_id = ?",
      "EXISTS ( SELECT 1 FROM deleted_accounts WHERE id = ? AND receipt_hash = ? )",
    ],
    ["flows/accountPurge/deletionCleanup.ts", "account_id = ?"],
  ],
};

for (const [key, expected] of Object.entries(boundaries)) {
  test(`${key}は指定の入口だけが条件つきで実行します`, () => {
    const actual = workerSqlWrites.filter(
      ({ operation, table }) => `${operation} ${table}` === key,
    );
    expect(actual.map(({ file }) => file).sort()).toEqual(expected.map(([file]) => file).sort());
    const remaining = [...actual];
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
  });
}

test("registration_flows.account_id を更新する文は退会の条件を使います", () => {
  for (const write of workerSqlWrites.filter(({ table }) => table === "registration_flows")) {
    for (const { columns, where } of updateClauses(write)) {
      if (columns.includes("account_id"))
        expect(
          hasSqlCondition(where, "registrationAccountAllowed"),
          `${write.file} の account_id の更新に registrationAccountAllowed が必要です`,
        ).toBe(true);
    }
  }
});

test("退会の大会エントリー消去は account_id を NULL にします", () => {
  const scrubs = workerSqlWrites.filter(
    ({ file, table, operation, sql }) =>
      file === "flows/accountPurge/deletionCleanup.ts" &&
      table === "tournament_entries" &&
      operation === "UPDATE" &&
      /\bSET\s+account_id\s*=\s*NULL\s*,\s*deleted\s*=\s*1\s+WHERE\b/i.test(sql),
  );
  expect(scrubs).toHaveLength(1);
});
