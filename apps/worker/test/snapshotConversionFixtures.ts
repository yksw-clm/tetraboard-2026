import { reversiArchives } from "../../../test-fixtures/matches";
import reversi from "../../../test-fixtures/matches/reversi-standard-draw.json";
import gomokuOn from "../../../test-fixtures/matches/gomoku-on-five.json";
import gomokuOff from "../../../test-fixtures/matches/gomoku-off-overline.json";
import ranked from "../../../test-fixtures/matches/four-gomoku-singles-ranked.json";
import full from "../../../test-fixtures/matches/four-gomoku-singles-full.json";
import mixed from "../../../test-fixtures/matches/four-gomoku-doubles-mixed.json";
import eliminated from "../../../test-fixtures/matches/four-gomoku-doubles-elimination.json";
import type { ExportRow } from "../scripts/snapshotMatchPlan";

function recordJson(detail: typeof reversi.detail | typeof gomokuOn.detail) {
  return JSON.stringify({
    ...detail,
    instanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    participants: detail.participants.map(({ avatarUrl: _avatar, ...player }) => ({
      ...player,
      accountId: player.seat === 0 ? "fixture-self" : null,
    })),
  });
}
export const snapshotConversionFixtures = [
  ...reversiArchives.map(({ name, recordJson: json }) => ({ name, json })),
  { name: "reversi", json: recordJson(reversi.detail) },
  { name: "gomoku-on", json: recordJson(gomokuOn.detail) },
  { name: "gomoku-off", json: recordJson(gomokuOff.detail) },
  ...[ranked, full, mixed, eliminated].map(({ name, recordJson: json }) => ({ name, json })),
];
export function exportRow(json: string): ExportRow {
  const record = JSON.parse(json);
  return { id: record.id, game: record.settings.game, record_json: json };
}
