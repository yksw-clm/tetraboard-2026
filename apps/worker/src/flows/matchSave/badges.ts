import { badgeEventStatement } from "../../adapters/community/badgeEvents";
import { badgeAwardStatements } from "../../adapters/record/badgeAwards";

export function matchBadgeStatements(db: D1Database, game: string, matchId: string) {
  const statements = badgeAwardStatements(db, game, matchId);
  if (statements.length > 0) statements.push(badgeEventStatement(db, matchId));
  return statements;
}
