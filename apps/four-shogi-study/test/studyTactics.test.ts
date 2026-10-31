import { expect, test } from "bun:test";
import { studyTacticalCases } from "../bench/studyTactics";
import { tacticInput } from "../bench/tacticsDiagnostics";
import { restoreStudyPosition } from "../src/domain/study";

test("検討CLIの正本集合はシングルス88展開・重要40と有効マジック8を保つ", async () => {
  const valid = [],
    skipped = [];
  for (const entry of studyTacticalCases()) {
    expect(entry.state.mode).toBe("singles");
    try {
      await restoreStudyPosition(tacticInput(entry.state));
      valid.push(entry);
    } catch (error) {
      expect(entry.critical).toBe(false);
      skipped.push({ id: entry.id, reason: String(error) });
    }
  }
  expect(valid).toHaveLength(88);
  expect(valid.filter((x) => x.critical)).toHaveLength(40);
  expect(valid.filter((x) => x.family === "valid-magic")).toHaveLength(8);
  expect(new Set(valid.map((x) => x.id)).size).toBe(88);
  expect(skipped).toHaveLength(8);
});
