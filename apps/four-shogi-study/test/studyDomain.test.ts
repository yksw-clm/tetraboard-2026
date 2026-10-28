import { expect, test } from "bun:test";
import { getAnalysisLegalActions, type AnalysisSetupInput } from "@tetraboard/four-shogi/analysis";
import {
  appendStudyEvent,
  cloneImportedStudy,
  createSetupStudy,
  createStudy,
  importReplayStudy,
  parseStudyDocument,
  resolveStudyPositions,
  restoreStudyPosition,
  selectStudyNode,
  setStudyPlayEnabled,
  studyPositionInput,
  updateStudySettings,
} from "../src/domain/study";
import { validatePublicReplay } from "../src/domain/publicReplay";
import fixture from "../../../test-fixtures/matches/shogi-singles.json";
import doubles from "../../../test-fixtures/matches/shogi-doubles.json";

function publicDetail() {
  const { selfPlayerId: _self, ...detail } = fixture.detail;
  return detail;
}
function pages() {
  return [0, 100].map((start) => ({
    matchId: fixture.detail.id,
    rulesVersion: 1,
    initial: fixture.detail.replay.initial,
    eventCount: fixture.events.length,
    events: fixture.events.slice(start, start + 100),
    nextCursor: start + 100 < fixture.events.length ? start + 100 : null,
  }));
}

test("元の本譜を残して分岐し、同じ着手は同じ子局面へ戻り、選択だけではCPUを動かさない", async () => {
  const original = await createStudy({ nowMs: 0 });
  const playing = setStudyPlayEnabled(original, true, 1);
  const initial = await restoreStudyPosition(studyPositionInput(playing));
  const [first, second] = getAnalysisLegalActions(initial);
  const main = await appendStudyEvent(playing, { type: "action", side: "south", action: first }, 2);
  const root = selectStudyNode(main, "root", 3);
  expect(root.playEnabled).toBe(false);
  const branch = await appendStudyEvent(root, { type: "action", side: "south", action: second }, 4);
  expect(branch.nodes).toHaveLength(3);
  expect(main.nodes).toHaveLength(2);
  expect(original.nodes).toHaveLength(1);
  const selected = await appendStudyEvent(selectStudyNode(branch, "root"), {
    type: "action",
    side: "south",
    action: first,
  });
  expect(selected.currentNodeId).toBe(main.currentNodeId);
  expect(selected.nodes).toHaveLength(3);
  const restored = await parseStudyDocument(JSON.parse(JSON.stringify(branch)));
  expect((await restoreStudyPosition(studyPositionInput(restored))).stateHash).toBe(
    (await restoreStudyPosition(studyPositionInput(branch))).stateHash,
  );
  expect(restored.currentNodeId).toBe(branch.currentNodeId);
  expect(Object.isFrozen(branch.nodes)).toBe(true);
});

test("解析状態・反復履歴・攻撃履歴を表示frameからではなく元棋譜と経路から復元する", async () => {
  const replay = await validatePublicReplay(publicDetail(), pages());
  const imported = await importReplayStudy(replay, { title: "公開対局" });
  const selected = selectStudyNode(imported, "event-49");
  const position = await restoreStudyPosition(studyPositionInput(selected));
  expect(position.state.attackRelations.length).toBeGreaterThan(0);
  expect(Object.keys(position.state.repetitions).length).toBeGreaterThan(10);
  const restored = await parseStudyDocument(JSON.parse(JSON.stringify(selected)));
  expect((await resolveStudyPositions(restored)).get("event-49")?.state).toEqual(position.state);
  expect(imported.nodes).toHaveLength(fixture.events.length + 1);
  expect(imported.playEnabled).toBe(false);
});

test("編集確定は別検討の起点になり、元棋譜・攻撃履歴を上書きしない", async () => {
  const source = await createStudy();
  const position = await restoreStudyPosition(studyPositionInput(source));
  const setup: AnalysisSetupInput = {
    schemaVersion: 1,
    board: position.state.board.map((row) =>
      row.map((piece) =>
        piece ? { side: piece.side, kind: piece.kind, promoted: piece.promoted } : null,
      ),
    ),
    hands: position.state.hands,
    turn: "south",
    threePlayerAttackProhibited: false,
    eliminations: [{ side: "west", rank: 4, group: 1 }],
  };
  const edited = await createSetupStudy(setup, {
    sourceReference: { studyId: source.id, nodeId: "root" },
  });
  expect(edited.id).not.toBe(source.id);
  expect(edited.origin.kind).toBe("setup");
  expect(source.origin.kind).toBe("replay");
  const result = await restoreStudyPosition(studyPositionInput(edited));
  expect(result.state.eliminations).toHaveLength(1);
  expect(result.state.repetitions).not.toEqual(position.state.repetitions);
  expect(result.state.attackRelations).toEqual([]);
  expect(result.eventOffset).toBe(0);
});

test("保存データの循環・欠落・非合法な分岐・版・設定を受け付けない", async () => {
  const study = await createStudy();
  const json = JSON.parse(JSON.stringify(study));
  await expect(parseStudyDocument({ ...json, schemaVersion: 99 })).rejects.toThrow();
  await expect(parseStudyDocument({ ...json, currentNodeId: "missing" })).rejects.toThrow();
  await expect(
    parseStudyDocument({
      ...json,
      nodes: [
        ...json.nodes,
        {
          id: "cycle",
          parentId: "cycle",
          event: { type: "eliminate", side: "south", reason: "resigned" },
        },
      ],
    }),
  ).rejects.toThrow();
  await expect(
    parseStudyDocument({
      ...json,
      nodes: [
        ...json.nodes,
        {
          id: "bad",
          parentId: "root",
          event: {
            type: "action",
            side: "west",
            action: { type: "dropPiece", pieceKind: "rook", to: { x: 0, y: 0 } },
          },
        },
      ],
    }),
  ).rejects.toThrow();
  expect(() => updateStudySettings(study, { threads: 0 })).toThrow();
  expect(() => updateStudySettings(study, { memoryMb: Infinity })).toThrow();
  expect(() => updateStudySettings(study, { mode: "invalid" as "auto" })).toThrow();
  const cloned = await cloneImportedStudy(json);
  expect(cloned.id).not.toBe(study.id);
  expect(cloned.nodes).toEqual(study.nodes);
  expect(cloned.playEnabled).toBe(false);
});

test("公開棋譜は全ページの連続番号・対局識別子・終局一致を検証する", async () => {
  const full = pages();
  expect((await validatePublicReplay({ match: publicDetail() }, full)).events).toHaveLength(
    fixture.events.length,
  );
  await expect(validatePublicReplay(publicDetail(), [full[0]])).rejects.toThrow();
  await expect(validatePublicReplay(publicDetail(), [full[1], full[0]])).rejects.toThrow();
  await expect(
    validatePublicReplay(publicDetail(), [full[0], { ...full[1], matchId: crypto.randomUUID() }]),
  ).rejects.toThrow();
  await expect(
    validatePublicReplay(publicDetail(), [
      full[0],
      { ...full[1], events: full[1].events.slice(1) },
    ]),
  ).rejects.toThrow();
  const altered = structuredClone(publicDetail());
  altered.game.moveNumber++;
  await expect(validatePublicReplay(altered, full)).rejects.toThrow("終局");
  const { selfPlayerId: _self, ...doubleDetail } = doubles.detail;
  await expect(validatePublicReplay(doubleDetail, [])).rejects.toThrow("シングルス");
});
