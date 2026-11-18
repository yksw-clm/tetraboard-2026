import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { findSqlWrites, hasRequiredWhereTerms, workerSqlWrites } from "./sqlWrites";

const tables: Record<string, [file: string, ...terms: string[]][]> = {
  account_room_seats: [
    ["adapters/matchmaking/seatWrites.ts", "${fence.sql}"],
    ["adapters/room/seatReservations.ts", "${fence.sql}"],
    ["adapters/tournament/seatWrites.ts", "${fence.sql}"],
  ],
  privacy_room_accounts: [
    ["adapters/privacy/guestMergeWrites.ts", 'NOT ${deletedAccountExistsSql("?")}'],
    ["adapters/record/matchClaimStore.ts", 'NOT ${deletedAccountExistsSql("c.account_id")}'],
    ["adapters/room/seatReservations.ts", 'NOT ${deletedAccountExistsSql("s.account_id")}'],
  ],
  privacy_room_players: [
    ["adapters/privacy/guestMergeWrites.ts", 'NOT ${deletedAccountExistsSql("?")}'],
    ["adapters/room/seatReservations.ts", 'NOT ${deletedAccountExistsSql("s.account_id")}'],
  ],
  tournament_entries: [
    ["adapters/tournament/entries.ts", 'NOT ${deletedAccountExistsSql("user.id")}'],
  ],
  deletion_challenges: [
    [
      "adapters/privacy/deletionConfirmation.ts",
      "( SELECT COUNT ( * ) FROM deletion_challenges WHERE account_id = ? AND created_at_ms > ? ) < ?",
    ],
  ],
};

for (const [table, expected] of Object.entries(tables)) {
  test(`${table}へのINSERTは指定の入口で必須の条件を使います`, () => {
    const writes = workerSqlWrites.filter(
      (write) => write.table === table && write.operation === "INSERT",
    );
    expect(writes.map(({ file }) => file).sort()).toEqual(expected.map(([file]) => file).sort());
    for (const [file, ...terms] of expected) {
      const write = writes.find((write) => write.file === file)!;
      expect(
        hasRequiredWhereTerms(write, ...terms),
        `${file} の WHERE に ${terms.join(", ")} が必要です`,
      ).toBe(true);
    }
  });
}

test("共有の席フェンスは退会条件を必須の AND 項にします", () => {
  const source = readFileSync(
    new URL("../src/flows/accountSeats/fences.ts", import.meta.url),
    "utf8",
  );
  const fence = source.match(/^export function seatFence\([\s\S]*?^}/m)?.[0];
  const sql = fence?.match(/sql: `([^`]+)`/)?.[1];
  expect(sql).toBeDefined();
  const [write] = findSqlWrites(
    "seatFence.ts",
    "`INSERT INTO account_room_seats SELECT id FROM user WHERE " + sql + "`",
  );
  expect(hasRequiredWhereTerms(write!, "NOT ${deletedAccountExistsSql(account)}")).toBe(true);
});
