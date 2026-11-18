import { expect, test } from "bun:test";
import { findSqlWrites, hasRequiredWhereTerms, hasSqlCondition, updateClauses } from "./sqlWrites";

test("表名の3種類の引用とTypeScriptのエスケープを解釈します", () => {
  const statements = [
    'INSERT INTO "guest_account_merges" VALUES(?,?,?)',
    "INSERT OR IGNORE INTO main.`GUEST_ACCOUNT_MERGES` VALUES(?,?,?)",
    "INSERT INTO [guest_account_merges] VALUES(?,?,?)",
  ];
  const source = [
    ...statements.map((statement) => JSON.stringify(statement) + ";"),
    "`INSERT INTO \\`guest_account_merges\\` VALUES(?,?,?)`;",
  ].join("\n");

  const writes = findSqlWrites("example.ts", source);

  expect(writes.map(({ operation, table }) => [operation, table])).toEqual(
    Array.from({ length: 4 }, () => ["INSERT", "guest_account_merges"]),
  );
});

test("UPDATEの代入先を値の式、条件、RETURNINGの列と区別します", () => {
  const statement = `UPDATE "registration_flows" SET
    seat_state=COALESCE((SELECT name FROM user WHERE account_id=?), 'account_id=?'),
    completed_at_ms=?
    WHERE account_id=? RETURNING account_id`;
  const [write] = findSqlWrites("example.ts", JSON.stringify(statement));

  expect(updateClauses(write!)[0]!.columns).toEqual(["seat_state", "completed_at_ms"]);
});

test("UPDATEの列リストから引用されたaccount_idを検出します", () => {
  const statement = 'UPDATE [registration_flows] SET ("ACCOUNT_ID", session_id)=(?,?) WHERE id=?';
  const [write] = findSqlWrites("example.ts", JSON.stringify(statement));
  const [clause] = updateClauses(write!);

  expect(clause!.columns).toEqual(["account_id", "session_id"]);
  expect(hasSqlCondition(clause!.where, "registrationAccountAllowed")).toBe(false);
});

test("UPSERTでは更新側のWHEREに退会の条件を求めます", () => {
  const source =
    "`INSERT INTO registration_flows(id,account_id) SELECT ?,? WHERE ${registrationAccountAllowed('?')} " +
    "ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id " +
    "ON CONFLICT DO UPDATE SET account_id=excluded.account_id WHERE ${registrationAccountAllowed('?')}`";
  const [write] = findSqlWrites("example.ts", source);

  expect(
    updateClauses(write!).map(({ columns, where }) => ({
      columns,
      guarded: hasSqlCondition(where, "registrationAccountAllowed"),
    })),
  ).toEqual([
    { columns: ["account_id"], guarded: false },
    { columns: ["account_id"], guarded: true },
  ]);
});

test("単引用符で囲まれたUPDATEの対象表と代入先を検出します", () => {
  const statement = "UPDATE 'registration_flows' SET account_id=? WHERE id=?";
  const [write] = findSqlWrites("example.ts", JSON.stringify(statement));

  expect(write?.table).toBe("registration_flows");
  expect(updateClauses(write!)[0]!.columns).toEqual(["account_id"]);
});

test("DELETE FROM の対象表を副問い合わせと区別します", () => {
  const statement =
    'DELETE FROM main."notification_events" WHERE EXISTS(SELECT 1 FROM deleted_accounts)';
  const writes = findSqlWrites("example.ts", JSON.stringify(statement));
  expect(writes.map(({ operation, table }) => [operation, table])).toEqual([
    ["DELETE", "notification_events"],
  ]);
});

test.each([
  ["(${fence.sql}) AND (state=? OR state=?)", true],
  ["${fence.sql} OR 1", false],
  ["(${fence.sql} OR 1)", false],
  ["NOT ${fence.sql}", false],
  ["${fence.sql} = 0", false],
  ["EXISTS (SELECT 1 FROM user WHERE ${fence.sql})", false],
  ["id=? ON CONFLICT(id) DO UPDATE SET id=? WHERE ${fence.sql}", false],
])("WHERE %s の必須項を検査します", (where, required) => {
  const source = "`INSERT INTO account_room_seats(id) SELECT ? WHERE " + where + "`";
  const [write] = findSqlWrites("example.ts", source);
  expect(hasRequiredWhereTerms(write!, "${fence.sql}")).toBe(required);
});

test.each([
  ["active=1", "AND (lease_until_ms>? OR pending=1)", true],
  ["active=1 OR valid=1", "AND lease_until_ms>?", false],
  ["active=1", "OR lease_until_ms>?", false],
])("同じ関数内の定数と省略可能な SQL 断片も検査します (%s, %s)", (candidate, suffix, required) => {
  const source = [
    "function write() {",
    'const candidate = { sql: "FROM user WHERE ' + candidate + '" };',
    "return `INSERT INTO account_room_seats(id) SELECT id ${candidate.sql} AND ${fence.sql}",
    "${pending ? ` " + suffix + '` : ""}`;',
    "}",
  ].join("\n");
  const [write] = findSqlWrites("example.ts", source);
  expect(hasRequiredWhereTerms(write!, "${fence.sql}")).toBe(required);
});

test.each(["UNION", "union all", "INTERSECT", "EXCEPT"])(
  "INSERTの元になるSELECTに最上位の%sがあれば拒否します",
  (operator) => {
    const source =
      "`INSERT INTO account_room_seats(id) SELECT ? WHERE ${fence.sql} " + operator + " SELECT ?`";
    const [write] = findSqlWrites("example.ts", source);

    expect(hasRequiredWhereTerms(write!, "${fence.sql}")).toBe(false);
  },
);

test("INSERTの元になるSELECTでサブクエリ内の複合演算子を許します", () => {
  const source =
    "`INSERT INTO account_room_seats(id) SELECT id FROM (SELECT ? AS id UNION ALL SELECT ?) " +
    "WHERE ${fence.sql} AND id IN (SELECT ? INTERSECT SELECT ? EXCEPT SELECT ?)`";
  const [write] = findSqlWrites("example.ts", source);

  expect(hasRequiredWhereTerms(write!, "${fence.sql}")).toBe(true);
});
