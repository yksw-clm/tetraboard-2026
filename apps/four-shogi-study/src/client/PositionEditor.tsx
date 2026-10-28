import { useState } from "react";
import type {
  FourShogiState,
  HandPieceKind,
  PieceKind,
  Position,
  Side,
} from "@tetraboard/four-shogi";
import type { AnalysisSetupInput } from "@tetraboard/four-shogi/analysis";
import { ShogiPiece } from "@tetraboard/shogi-ui/piece";
import { Button, Field, Panel, fieldClass } from "./ui";
import { sideNames, sideOrder } from "./presentation";

export function setupFromState(state: FourShogiState): AnalysisSetupInput {
  return {
    schemaVersion: 1,
    board: state.board.map((row) =>
      row.map((piece) =>
        piece ? { side: piece.side, kind: piece.kind, promoted: piece.promoted } : null,
      ),
    ),
    hands: structuredClone(state.hands),
    turn: state.turn ?? "south",
    threePlayerAttackProhibited: state.threePlayerAttackProhibited,
    eliminations: state.eliminations
      .filter((entry) => entry.rank !== null)
      .map((entry) => ({ side: entry.side, rank: entry.rank!, group: entry.group })),
  };
}
export type EditorState = {
  setup: AnalysisSetupInput;
  selected: Position | null;
  tool: "place" | "move" | "erase";
  side: Side;
  kind: PieceKind;
  promoted: boolean;
};
export function createEditor(state: FourShogiState): EditorState {
  return {
    setup: setupFromState(state),
    selected: null,
    tool: "move",
    side: "south",
    kind: "pawn",
    promoted: false,
  };
}
export function editSquare(editor: EditorState, position: Position): EditorState {
  if (editor.tool === "move" && !editor.selected)
    return editor.setup.board[position.y][position.x] ? { ...editor, selected: position } : editor;
  if (editor.selected?.x === position.x && editor.selected.y === position.y)
    return { ...editor, selected: null };
  const board = editor.setup.board.map((row) => [...row]);
  if (editor.tool === "erase") board[position.y][position.x] = null;
  else if (editor.tool === "place")
    board[position.y][position.x] = {
      side: editor.side,
      kind: editor.kind,
      promoted: editor.promoted && editor.kind !== "king" && editor.kind !== "gold",
    };
  else if (editor.selected) {
    board[position.y][position.x] = board[editor.selected.y][editor.selected.x];
    board[editor.selected.y][editor.selected.x] = null;
  }
  return { ...editor, selected: null, setup: { ...editor.setup, board } };
}
const pieceLabels: Record<PieceKind, string> = {
  king: "玉",
  rook: "飛",
  gold: "金",
  silver: "銀",
  pawn: "歩",
};
export function PositionEditor({
  editor,
  setEditor,
  busy,
  save,
  cancel,
}: {
  editor: EditorState;
  setEditor(value: EditorState): void;
  busy: boolean;
  save(setup: AnalysisSetupInput, title: string): Promise<boolean>;
  cancel(): void;
}) {
  const [title, setTitle] = useState("編集局面からの検討");
  const updateSetup = (setup: Partial<AnalysisSetupInput>) =>
    setEditor({ ...editor, setup: { ...editor.setup, ...setup } });
  const selected = editor.selected
    ? editor.setup.board[editor.selected.y][editor.selected.x]
    : null;
  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <Panel title="盤面を編集" eyebrow="POSITION EDITOR">
        <p className="mb-4 text-xs leading-relaxed text-[#839174]">
          駒の移動・配置・削除、持ち駒と手番を編集できます。
        </p>
        <div className="mb-4 flex gap-1">
          {(
            [
              ["move", "移動"],
              ["place", "配置"],
              ["erase", "削除"],
            ] as const
          ).map(([tool, label]) => (
            <Button
              key={tool}
              variant={editor.tool === tool ? "primary" : "secondary"}
              className="flex-1"
              onPress={() => setEditor({ ...editor, tool, selected: null })}
            >
              {label}
            </Button>
          ))}
        </div>
        {editor.tool === "move" ? (
          <p className="mb-4 text-xs text-[#748468]">
            {selected ? "移動先のマスを選んでください。" : "動かす駒を選んでください。"}
          </p>
        ) : editor.tool === "erase" ? (
          <p className="mb-4 text-xs text-[#a16e45]">取り除く駒を選んでください。</p>
        ) : (
          <div className="mb-4 space-y-3">
            <Field label="駒の所属">
              <select
                aria-label="配置する駒の所属"
                value={editor.side}
                className={fieldClass}
                onChange={(event) => setEditor({ ...editor, side: event.target.value as Side })}
              >
                {sideOrder.map((side) => (
                  <option key={side} value={side}>
                    {sideNames[side]}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex gap-1">
              {(["king", "rook", "gold", "silver", "pawn"] as const).map((kind) => (
                <button
                  key={kind}
                  aria-label={`${pieceLabels[kind]}を配置`}
                  aria-pressed={editor.kind === kind}
                  className={`flex flex-1 items-center justify-center rounded-lg border p-1 [--shogi-piece-width:30px] ${editor.kind === kind ? "border-[#6d8e56] bg-[#e8efdd]" : "border-[#e2e6d9] bg-[#fafbf7]"}`}
                  onClick={() =>
                    setEditor({
                      ...editor,
                      kind,
                      promoted: kind === "king" || kind === "gold" ? false : editor.promoted,
                    })
                  }
                >
                  <ShogiPiece kind={kind} direction="up" />
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={editor.promoted}
                disabled={editor.kind === "king" || editor.kind === "gold"}
                onChange={(event) => setEditor({ ...editor, promoted: event.target.checked })}
              />
              成駒を配置
            </label>
          </div>
        )}
        <Field label="次の手番">
          <select
            className={fieldClass}
            value={editor.setup.turn}
            onChange={(event) => updateSetup({ turn: event.target.value as Side })}
          >
            {sideOrder.map((side) => (
              <option
                key={side}
                value={side}
                disabled={editor.setup.eliminations.some((entry) => entry.side === side)}
              >
                {sideNames[side]}
              </option>
            ))}
          </select>
        </Field>
        <label className="mt-4 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={editor.setup.threePlayerAttackProhibited}
            onChange={(event) => updateSetup({ threePlayerAttackProhibited: event.target.checked })}
          />
          三人攻撃禁止
        </label>
        <Button
          variant="quiet"
          className="mt-4 w-full"
          onPress={() =>
            updateSetup({
              board: editor.setup.board.map((row) =>
                row.map((piece) => (piece?.kind === "king" ? piece : null)),
              ),
              hands: {
                south: { rook: 0, gold: 0, silver: 0, pawn: 0 },
                west: { rook: 0, gold: 0, silver: 0, pawn: 0 },
                north: { rook: 0, gold: 0, silver: 0, pawn: 0 },
                east: { rook: 0, gold: 0, silver: 0, pawn: 0 },
              },
            })
          }
        >
          玉以外の駒をすべて取り除く
        </Button>
      </Panel>
      <Panel title="持ち駒">
        <div className="grid grid-cols-[24px_repeat(4,minmax(0,1fr))] items-center gap-2 text-xs">
          <span />
          {(["rook", "gold", "silver", "pawn"] as const).map((kind) => (
            <span key={kind} className="text-center text-[#7c8a6f]">
              {pieceLabels[kind]}
            </span>
          ))}
          {sideOrder.map((side) => (
            <HandFields
              key={side}
              side={side}
              setup={editor.setup}
              update={(kind, count) =>
                updateSetup({
                  hands: {
                    ...editor.setup.hands,
                    [side]: { ...editor.setup.hands[side], [kind]: count },
                  },
                })
              }
            />
          ))}
        </div>
      </Panel>
      <Panel title="脱落状況">
        <p className="mb-3 text-[10px] leading-relaxed text-[#8d977f]">
          脱落した玉も裏王として盤面に残します。数字は脱落した順番です。
        </p>
        <div className="space-y-2">
          {sideOrder.map((side) => (
            <label key={side} className="flex items-center justify-between text-xs">
              <span>{sideNames[side]}</span>
              <select
                aria-label={`${sideNames[side]}の脱落状況`}
                className={`${fieldClass} !w-36 !py-1`}
                value={editor.setup.eliminations.find((entry) => entry.side === side)?.group ?? 0}
                onChange={(event) => {
                  const group = Number(event.target.value);
                  const entries = [
                    ...editor.setup.eliminations.filter((entry) => entry.side !== side),
                    ...(group ? [{ side, rank: 4, group }] : []),
                  ].sort((a, b) => a.group - b.group);
                  const groups = [...new Set(entries.map((entry) => entry.group))];
                  const eliminations = entries.map((entry) => ({
                    ...entry,
                    group: groups.indexOf(entry.group) + 1,
                    rank: 5 - entries.filter((other) => other.group <= entry.group).length,
                  }));
                  updateSetup({
                    eliminations,
                    ...(group
                      ? {
                          hands: {
                            ...editor.setup.hands,
                            [side]: { rook: 0, gold: 0, silver: 0, pawn: 0 },
                          },
                        }
                      : {}),
                  });
                }}
              >
                <option value="0">生存</option>
                <option value="1">1組目に脱落</option>
                <option value="2">2組目に脱落</option>
              </select>
            </label>
          ))}
        </div>
      </Panel>
      <Panel title="この局面から始める">
        <div className="space-y-4">
          <Field label="検討名">
            <input
              className={fieldClass}
              value={title}
              maxLength={100}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <p className="text-[11px] leading-relaxed text-[#879478]">
            新しい検討として保存します。元の棋譜と分岐は残り、千日手と攻撃の履歴はこの局面から数えます。
          </p>
          <Button
            variant="primary"
            className="w-full"
            isDisabled={busy || !title.trim()}
            onPress={() => void save(editor.setup, title.trim())}
          >
            局面を確認して検討開始
          </Button>
          <Button className="w-full" isDisabled={busy} onPress={cancel}>
            編集を取り消す
          </Button>
        </div>
      </Panel>
    </aside>
  );
}
function HandFields({
  side,
  setup,
  update,
}: {
  side: Side;
  setup: AnalysisSetupInput;
  update(kind: HandPieceKind, count: number): void;
}) {
  return (
    <>
      <span>{sideNames[side]}</span>
      {(["rook", "gold", "silver", "pawn"] as const).map((kind) => (
        <input
          key={kind}
          type="number"
          min={0}
          max={12}
          aria-label={`${sideNames[side]}の持ち駒${pieceLabels[kind]}`}
          className={`${fieldClass} !px-1 !py-1 text-center`}
          value={setup.hands[side][kind]}
          disabled={setup.eliminations.some((entry) => entry.side === side)}
          onChange={(event) =>
            update(kind, Math.max(0, Math.min(12, Math.floor(Number(event.target.value) || 0))))
          }
        />
      ))}
    </>
  );
}
