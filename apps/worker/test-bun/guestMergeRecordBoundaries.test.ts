import { expect, test } from "bun:test";
import ts from "typescript";

import { hasRequiredWhereTerms, updateClauses, workerSqlWrites } from "./sqlWrites";

function callsSqlHelper(expression: ts.Expression, helper: string): boolean {
  return (
    ts.isCallExpression(expression) &&
    ((ts.isIdentifier(expression.expression) && expression.expression.text === helper) ||
      expression.arguments.some((argument) => callsSqlHelper(argument, helper)))
  );
}

const allowed = {
  matches: { files: ["adapters/record/matchRecordStore.ts"], helper: "mergedRecordJsonSql" },
  match_uploads: { files: ["adapters/record/matchRecordStore.ts"], helper: "mergedRecordJsonSql" },
  account_match_history: {
    files: [
      "adapters/record/publication.ts",
      "adapters/record/publication.ts",
      "adapters/record/matchClaimStore.ts",
    ],
    helper: "mergedAccountIdSql",
  },
};
for (const [table, { files, helper }] of Object.entries(allowed)) {
  test(`${table}へのINSERTは指定の入口だけで統合先のSQLを使います`, () => {
    const writes = workerSqlWrites.filter(
      (write) => write.table === table && write.operation === "INSERT",
    );
    expect(writes.map(({ file }) => file).sort()).toEqual([...files].sort());
    for (const write of writes) {
      // 統合先への変換は SELECT の列にあり、WHERE は最上位の OR を検査します。
      expect(
        hasRequiredWhereTerms(write),
        `${write.file} の WHERE に最上位の OR は使えません`,
      ).toBe(true);
      const { node, source } = write;
      expect(
        ts.isTemplateExpression(node) &&
          node.templateSpans.some(({ expression }) => callsSqlHelper(expression, helper)),
      ).toBe(true);
      expect(
        source.statements.some(
          (node) =>
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            /(?:^|\/)guestMerges$/.test(node.moduleSpecifier.text) &&
            node.importClause?.namedBindings &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            node.importClause.namedBindings.elements.some(
              (item) => item.name.text === helper && !item.propertyName,
            ),
        ),
      ).toBe(true);
    }
  });
}

test("公開済み・保存待ちの棋譜は指定の箇所でだけ書き込みます", () => {
  const writes = workerSqlWrites.filter(
    ({ table }) => table === "matches" || table === "match_uploads",
  );
  expect(
    writes.map(({ table, operation, file }) => `${table} ${operation} ${file}`).sort(),
  ).toEqual([
    "match_uploads DELETE adapters/record/publication.ts",
    "match_uploads INSERT adapters/record/matchRecordStore.ts",
    "match_uploads UPDATE adapters/record/guestMergeWrites.ts",
    "match_uploads UPDATE adapters/record/matchRecordStore.ts",
    "match_uploads UPDATE adapters/record/privacyScrub.ts",
    "matches INSERT adapters/record/matchRecordStore.ts",
    "matches UPDATE adapters/record/guestMergeWrites.ts",
    "matches UPDATE adapters/record/privacyScrub.ts",
  ]);
});

test("棋譜の引き継ぎ状態は指定の箇所でだけ更新します", () => {
  const stateUpdates = workerSqlWrites
    .filter(({ table }) => table === "match_participant_accounts")
    .filter((write) => updateClauses(write).some(({ columns }) => columns.includes("state")));
  expect(stateUpdates.map(({ file }) => file)).toEqual([
    "adapters/record/matchClaimStore.ts",
    "adapters/record/matchClaimStore.ts",
  ]);
});
