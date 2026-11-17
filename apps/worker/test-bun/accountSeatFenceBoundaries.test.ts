import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

const root = new URL("../src/", import.meta.url);
const allowed = {
  account_room_seats: [
    "accounts/roomAccounts.ts",
    "adapters/matchmaking/seatWrites.ts",
    "adapters/tournament/seatWrites.ts",
  ],
  matchmaking_wait_reservations: ["adapters/matchmaking/joinWrites.ts"],
  tournament_wait_reservations: ["adapters/tournament/queue.ts"],
};
const conditions = {
  account_room_seats: "seatFence",
  matchmaking_wait_reservations: "matchmakingWaitFence",
  tournament_wait_reservations: "tournamentWaitFence",
};
const sources = readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file, source: readFileSync(new URL(file, root), "utf8") }));

for (const [table, files] of Object.entries(allowed)) {
  test(`${table}へのINSERTは指定の入口だけで共有の条件を使います`, () => {
    const inserts = new RegExp(`INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}\\b`, "gi");
    const found: string[] = [];
    for (const { file, source } of sources) {
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      for (const match of source.matchAll(inserts)) {
        found.push(file);
        const condition = conditions[table as keyof typeof conditions];
        let sql = "";
        let scope = source;
        function visit(node: ts.Node) {
          if (node.getStart(parsed) <= match.index && node.end > match.index) {
            if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
              scope = node.getText(parsed);
            if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node))
              sql = node.getText(parsed);
            ts.forEachChild(node, visit);
          }
        }
        visit(parsed);
        expect(sql).toMatch(/\b(?:WHERE|AND)\s+\$\{fence\.sql\}/);
        expect(sql).not.toMatch(/\?\d/);
        expect(scope).toContain(`const fence = ${condition}(`);
        expect(scope).toContain("...fence.values");
        const imported = parsed.statements.some(
          (node) =>
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text.endsWith("accountSeats/fences") &&
            node.importClause?.namedBindings &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            node.importClause.namedBindings.elements.some(
              (item) => item.name.text === condition && !item.propertyName,
            ),
        );
        expect(imported).toBe(true);
      }
    }
    expect(found.sort()).toEqual(
      [...files, ...(table === "tournament_wait_reservations" ? files : [])].sort(),
    );
  });
}
