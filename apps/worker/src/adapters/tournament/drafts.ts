import type { TournamentDraftStore } from "@tetraboard/context-tournament";
import type { TournamentInput } from "@tetraboard/protocol";
export class D1TournamentDrafts implements TournamentDraftStore {
  constructor(private db: D1Database) {}
  async create(input: TournamentInput, key: string, now: number) {
    await this.db
      .prepare(
        `INSERT INTO tournaments(key,name,description,rules_description,starts_at_ms,ends_at_ms,created_at_ms,updated_at_ms,rule_version,game,settings_json) VALUES(?,?,?,?,?,?,?,?,2,?,?)`,
      )
      .bind(
        key,
        input.name,
        input.description,
        input.rulesDescription,
        input.startsAtMs,
        input.endsAtMs,
        now,
        now,
        input.settings.game,
        JSON.stringify(input.settings),
      )
      .run();
  }
  async update(key: string, input: TournamentInput, version: number, now: number) {
    return (
      (
        await this.db
          .prepare(`UPDATE tournaments SET name=?,description=?,rules_description=?,starts_at_ms=?,ends_at_ms=?,version=version+1,updated_at_ms=?,rule_version=CASE WHEN published=0 THEN 2 ELSE rule_version END,game=?,settings_json=?
    WHERE key=? AND version=? AND (published=0 OR (starts_at_ms IS ? AND ends_at_ms IS ? AND game=? AND (rule_version=1 OR settings_json=?)))`)
          .bind(
            input.name,
            input.description,
            input.rulesDescription,
            input.startsAtMs,
            input.endsAtMs,
            now,
            input.settings.game,
            JSON.stringify(input.settings),
            key,
            version,
            input.startsAtMs,
            input.endsAtMs,
            input.settings.game,
            JSON.stringify(input.settings),
          )
          .run()
      ).meta.changes === 1
    );
  }
}
