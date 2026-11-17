import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

const root = new URL("../src/", import.meta.url);
const allowed = {
  matches: { files: ["adapters/record/matchRecordStore.ts"], helper: "mergedRecordJsonSql" },
  match_uploads: { files: ["adapters/record/matchRecordStore.ts"], helper: "mergedRecordJsonSql" },
  account_match_history: {
    files: [
      "adapters/record/publication.ts",
      "adapters/record/publication.ts",
      "accounts/matchClaims.ts",
    ],
    helper: "mergedAccountIdSql",
  },
};
const sources = readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file, source: readFileSync(new URL(file, root), "utf8") }));

for (const [table, { files, helper }] of Object.entries(allowed)) {
  test(`${table}へのINSERTは指定の入口だけで統合先のSQLを使います`, () => {
    const inserts = new RegExp(`INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}\\b`, "gi");
    const found: string[] = [];
    for (const { file, source } of sources) {
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      for (const match of source.matchAll(inserts)) {
        found.push(file);
        let sql: ts.TemplateExpression | undefined;
        function visit(node: ts.Node) {
          if (node.getStart(parsed) <= match.index && node.end > match.index) {
            if (ts.isTemplateExpression(node)) sql = node;
            ts.forEachChild(node, visit);
          }
        }
        visit(parsed);
        expect(
          sql?.templateSpans.some(
            ({ expression }) =>
              ts.isCallExpression(expression) &&
              ts.isIdentifier(expression.expression) &&
              expression.expression.text === helper,
          ),
        ).toBe(true);
        expect(
          parsed.statements.some(
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
    }
    expect(found.sort()).toEqual([...files].sort());
  });
}
