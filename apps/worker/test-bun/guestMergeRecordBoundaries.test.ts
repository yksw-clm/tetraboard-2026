import { expect, test } from "bun:test";
import ts from "typescript";

import { hasRequiredWhereTerms, workerSqlWrites } from "./sqlWrites";
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
          node.templateSpans.some(
            ({ expression }) =>
              ts.isCallExpression(expression) &&
              ts.isIdentifier(expression.expression) &&
              expression.expression.text === helper,
          ),
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
