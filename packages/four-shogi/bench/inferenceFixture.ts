import { writeFileSync } from "node:fs";
import { restoreAnalysisPosition, getAnalysisLegalActions } from "../src/analysis";
import { encodeModelFeatures, featureVersion } from "../src/modelFeatures";
import {
  encodeAction,
  decodeAction,
  rotateAction,
  actionEncodingVersion,
} from "../src/actionEncoding";
import { sides } from "../src/types";
import archive from "../../../test-fixtures/matches/shogi-singles.json";

export async function createInferenceFixture() {
  const rows = [];
  for (const restricted of [false, true]) {
    const initial = {
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
      threePlayerAttackProhibited: restricted,
    };
    // 実エンジンの再生を通し、全実手番・攻撃/取り返し・脱落後の席対応を確認します。
    for (const offset of [0, 1, 2, 3, 6, 26]) {
      const position = await restoreAnalysisPosition({
        schemaVersion: 1,
        ruleProfileId: "tetraboard-four-shogi-singles-v1",
        rulesVersion: 1,
        initial,
        events: archive.events,
        eventOffset: offset,
      });
      rows.push({
        id: `${restricted ? "on" : "off"}-${offset}`,
        restricted,
        turn: position.state.turn,
        features: encodeModelFeatures(position),
        legalActionIds: getAnalysisLegalActions(position)
          .map(encodeAction)
          .sort((a, b) => a - b),
      });
    }
    const position = await restoreAnalysisPosition({
      schemaVersion: 1,
      ruleProfileId: "tetraboard-four-shogi-singles-v1",
      rulesVersion: 1,
      initial,
      events: [{ index: 0, event: { type: "eliminate", side: "west", reason: "left" } }],
    });
    rows.push({
      id: `${restricted ? "on" : "off"}-west-eliminated`,
      restricted,
      turn: position.state.turn,
      features: encodeModelFeatures(position),
      legalActionIds: getAnalysisLegalActions(position)
        .map(encodeAction)
        .sort((a, b) => a - b),
    });
  }
  return {
    format: "four-shogi-inference-fixture-v1",
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    rulesVersion: 1,
    featureVersion,
    actionEncodingVersion,
    valueOrder: [...sides, "noSoleWinner"],
    rows,
    actionCorrespondence: [0, 1, 12345, 13122, 13445].map((id) => ({
      id,
      action: decodeAction(id),
      rotations: sides.map((side) => encodeAction(rotateAction(decodeAction(id), side))),
    })),
  };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("新規fixture出力パスが必要です");
  writeFileSync(path, JSON.stringify(await createInferenceFixture(), null, 2) + "\n", {
    flag: "wx",
  });
}
