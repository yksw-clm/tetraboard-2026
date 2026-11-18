import { expect, test } from "bun:test";
import ts from "typescript";

import { hasRequiredWhereTerms, workerSqlWrites } from "./sqlWrites";
const allowed = {
  account_room_seats: [
    "adapters/room/seatReservations.ts",
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
for (const [table, files] of Object.entries(allowed)) {
  test(`${table}へのINSERTは指定の入口だけで共有の条件を使います`, () => {
    const writes = workerSqlWrites.filter(
      (write) => write.table === table && write.operation === "INSERT",
    );
    expect(writes.map(({ file }) => file).sort()).toEqual(
      [...files, ...(table === "tournament_wait_reservations" ? files : [])].sort(),
    );
    const condition = conditions[table as keyof typeof conditions];
    for (const write of writes) {
      const { sql, scope, source } = write;
      expect(
        hasRequiredWhereTerms(write, "${fence.sql}"),
        `${write.file} の WHERE に必須の席フェンスが必要です`,
      ).toBe(true);
      expect(sql).not.toMatch(/\?\d/);
      expect(scope.getText(source)).toContain(`const fence = ${condition}(`);
      expect(scope.getText(source)).toContain("...fence.values");
      const imported = source.statements.some(
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
  });
}
