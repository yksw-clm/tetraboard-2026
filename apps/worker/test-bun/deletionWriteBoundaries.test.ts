import { expect, test } from "bun:test";
import { workerSqlWrites } from "./sqlWrites";

test("deleted_accounts への INSERT は退会受付の adapter に集約する", () => {
  const inserts = workerSqlWrites.filter(
    ({ operation, table }) => operation === "INSERT" && table === "deleted_accounts",
  );
  expect(inserts.map(({ file }) => file)).toEqual(["adapters/privacy/deletionRequest.ts"]);
});
