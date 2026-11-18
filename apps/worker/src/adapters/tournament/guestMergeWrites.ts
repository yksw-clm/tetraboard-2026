export function guestTournamentTransferStatements(
  db: D1Database,
  guestId: string,
  targetId: string,
) {
  return [
    db
      .prepare("UPDATE tournament_entries SET account_id=? WHERE account_id=?")
      .bind(targetId, guestId),
    db
      .prepare("UPDATE tournament_match_players SET account_id=? WHERE account_id=?")
      .bind(targetId, guestId),
  ];
}
