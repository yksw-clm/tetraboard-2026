import { expect, test } from "bun:test";
import { hasRequiredWhereTerms, workerSqlWrites } from "./sqlWrites";

test("deleted_accounts への INSERT は退会受付の adapter に集約する", () => {
  const inserts = workerSqlWrites.filter(
    ({ operation, table }) => operation === "INSERT" && table === "deleted_accounts",
  );
  expect(inserts.map(({ file }) => file)).toEqual(["adapters/privacy/deletionRequest.ts"]);
});

test("退会受付の掲示板の削除は対象と受付を WHERE で照合する", () => {
  const writes = workerSqlWrites.filter(
    ({ file, sql }) =>
      file === "adapters/community/boardDeletion.ts" && sql.includes("${guard.sql}"),
  );
  expect(writes.map(({ operation, table }) => `${operation} ${table}`).sort()).toEqual([
    "DELETE board_likes",
    "UPDATE board_posts",
  ]);
  for (const write of writes)
    expect(hasRequiredWhereTerms(write, "account_id = ? 1", "${guard.sql}")).toBe(true);
});
