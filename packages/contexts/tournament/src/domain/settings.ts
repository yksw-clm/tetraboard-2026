import type { TournamentDefinition, TournamentSettings } from "@tetraboard/protocol";
import type { TournamentRow } from "./types";
export interface TournamentSettingsPolicy {
  settings(definition: TournamentDefinition): TournamentSettings;
  parseSettings(value: unknown): TournamentSettings;
}
export function settingsForTournament(
  row: TournamentRow,
  policy: TournamentSettingsPolicy,
): TournamentSettings {
  const settings = policy.settings({
    ruleVersion: row.rule_version,
    ...(row.rule_version === 2
      ? { settings: policy.parseSettings(JSON.parse(row.settings_json!)) }
      : {}),
  });
  if (settings.game !== (row.game ?? "four-shogi"))
    throw new Error("Tournament game does not match settings");
  return settings;
}
export function tournamentSettingsMatch(
  row: TournamentRow,
  definition: TournamentDefinition,
  policy: TournamentSettingsPolicy,
): boolean {
  const actual = settingsForTournament(row, policy),
    expected = policy.settings(definition);
  return (
    row.rule_version === definition.ruleVersion &&
    actual.game === expected.game &&
    actual.mode === expected.mode &&
    actual.timeControl.mainTimeMs === expected.timeControl.mainTimeMs &&
    actual.timeControl.byoyomiMs === expected.timeControl.byoyomiMs &&
    (actual.game !== "four-shogi" ||
      (expected.game === "four-shogi" &&
        actual.threePlayerAttackProhibited === expected.threePlayerAttackProhibited))
  );
}
