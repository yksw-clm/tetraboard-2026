import { useEffect, useMemo, useState } from "react";
import { getCheckState, type FourShogiState, type Side } from "@tetraboard/four-shogi";
import { FourShogiBoardLayout } from "@tetraboard/shogi-ui/board";
import type { ShogiBoardView } from "@tetraboard/shogi-ui/presentation";
import { useStudySession } from "./useStudySession";
import { Button, Panel } from "./ui";
import { EvaluationPanel } from "./EvaluationPanel";
import { FocusSelector } from "./FocusSelector";
import { NewStudyDialog, ImportDialog, SettingsDialog, LiveDialog } from "./StudyDialogs";
import { PositionEditor, createEditor, editSquare, type EditorState } from "./PositionEditor";
import {
  ancestorIds,
  orderedTree,
  scoreLabel,
  sideColors,
  sideNames,
  sideOrder,
  type EvaluationContext,
} from "./presentation";
import type { StudySnapshot } from "../contracts";
import type { StudySession } from "./useStudySession";
import { Field, fieldClass } from "./ui";

export function StudyApp() {
  const session = useStudySession();
  const sourceSnapshot = session.snapshot;
  const liveResultInvalid =
    sourceSnapshot?.live?.follow &&
    (!session.connected ||
      !["live", "finished"].includes(sourceSnapshot.live.status) ||
      sourceSnapshot.analysis?.status === "cancelled");
  const snapshot =
    sourceSnapshot && liveResultInvalid ? { ...sourceSnapshot, analysis: null } : sourceSnapshot;
  const [dialog, setDialog] = useState<"new" | "import" | "settings" | "live" | null>(null);
  const [viewerSide, setViewerSide] = useState<Side>("south");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [libraryVisible, setLibraryVisible] = useState(false);
  const path = useMemo(
    () => (snapshot ? ancestorIds(snapshot.study.nodes, snapshot.study.currentNodeId) : []),
    [snapshot?.study.nodes, snapshot?.study.currentNodeId],
  );
  const nextNode = snapshot?.study.nodes.find(
    (node) => node.parentId === snapshot.study.currentNodeId,
  );
  const select = (nodeId: string) => {
    if (!editor && !session.pending) void session.command({ type: "select", nodeId });
  };
  const previous = () => {
    if (path.length > 1) select(path[path.length - 2]);
  };
  const next = () => {
    if (nextNode) select(nextNode.id);
  };

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (
        editor ||
        dialog ||
        session.pending ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        (event.target instanceof Element &&
          event.target.closest("input,textarea,select,[contenteditable=true],[role=dialog]"))
      )
        return;
      if (event.key === "ArrowLeft" && path.length > 1) {
        event.preventDefault();
        void session.command({ type: "select", nodeId: path[path.length - 2] });
      }
      if (event.key === "ArrowRight" && nextNode) {
        event.preventDefault();
        void session.command({ type: "select", nodeId: nextNode.id });
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [editor, dialog, session, path, nextNode]);

  async function beginEditing() {
    if (!snapshot) return;
    if (
      await session.command(
        snapshot.live?.follow ? { type: "liveFollow", enabled: false } : { type: "pausePlay" },
      )
    )
      setEditor(createEditor(snapshot.position.state));
  }
  const state = snapshot?.position.state;
  const checks = useMemo(() => (state ? getCheckState(state) : undefined), [state]);
  const evaluation = snapshot?.analysis?.evaluation ?? snapshot?.staticEvaluation ?? null;
  const evaluationContext: EvaluationContext = snapshot?.analysis?.evaluation
    ? { source: "line", position: snapshot.position.state }
    : { source: "position" };
  const board: ShogiBoardView | null =
    editor && state
      ? {
          ...state,
          status: "playing",
          board: editor.setup.board.map((row, y) =>
            row.map((piece, x) => (piece ? { ...piece, id: y * 9 + x + 1 } : null)),
          ),
          hands: editor.setup.hands,
          turn: editor.setup.turn,
          eliminations: editor.setup.eliminations,
          lastMove: null,
        }
      : (state ?? null);
  const cpuTurn = !!state?.turn && snapshot?.study.settings.seats[state.turn].controller === "cpu";
  const cpuCount = snapshot
    ? sideOrder.filter((side) => snapshot.study.settings.seats[side].controller === "cpu").length
    : 0;
  const manual = snapshot?.study.settings.mode === "analysis";
  const waiting = snapshot?.study.playEnabled === false;
  const turnLabel =
    state?.status === "finished"
      ? "終局"
      : editor
        ? "盤面編集中"
        : `${state?.turn ? sideNames[state.turn] : "—"}の手番`;

  return (
    <div className="study-theme min-h-dvh">
      <header className="border-b border-[#dfe6d6] bg-[#fcfdf9] px-5 py-4 lg:px-8">
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-[#355841] text-xl font-semibold text-[#f3ead5]">
              将
            </div>
            <div>
              <h1 className="text-base font-bold tracking-[0.05em]">
                四人将棋 <span className="font-normal text-[#78876b]">検討室</span>
              </h1>
              <p className="mt-0.5 text-[9px] font-semibold tracking-[0.14em] text-[#9aa68c]">
                YOUR PERSONAL SHOGI WORKSPACE
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="mr-2 hidden items-center gap-1.5 rounded-full border border-[#dce6d3] px-2.5 py-1 text-[10px] text-[#7d906c] sm:flex">
              <span
                className={`size-1.5 rounded-full ${session.connected ? "bg-[#729f58]" : "bg-[#ccae6d]"}`}
              />
              {session.connected ? "Macで接続中" : "接続を確認中"}
            </span>
            <Button
              isDisabled={session.pending || !!editor}
              onPress={() => {
                session.clearError();
                setDialog("new");
              }}
            >
              ＋ 新しい対局
            </Button>
            <Button
              isDisabled={session.pending || !!editor}
              onPress={() => {
                session.clearError();
                setDialog("import");
              }}
            >
              棋譜を開く
            </Button>
            <Button
              isDisabled={session.pending || !!editor}
              onPress={() => {
                session.clearError();
                setDialog("live");
              }}
            >
              ライブ観戦
            </Button>
            <Button
              variant="quiet"
              isDisabled={!snapshot || !!editor}
              onPress={() => {
                session.clearError();
                setDialog("settings");
              }}
            >
              設定
            </Button>
          </div>
        </div>
      </header>
      {session.error && !dialog ? (
        <div
          role="alert"
          className="mx-auto mt-4 flex max-w-[1720px] items-start justify-between gap-3 rounded-xl border border-[#e4c9bd] bg-[#fff5ed] p-4 text-sm text-[#9f5944]"
        >
          <span>{session.error}</span>
          <button aria-label="エラーを閉じる" onClick={session.clearError}>
            ×
          </button>
        </div>
      ) : null}
      {!snapshot || !state || !board ? (
        <div className="grid min-h-[70vh] place-items-center">
          <div className="text-center">
            <span className="text-4xl text-[#8ca279]">将</span>
            <p className="mt-4 text-sm text-[#89977b]">
              {session.error ? "検討室に接続できませんでした。" : "検討室を準備しています…"}
            </p>
            {session.error ? (
              <Button className="mt-4" onPress={() => window.location.reload()}>
                再読み込み
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <main className="mx-auto max-w-[1800px] px-4 pb-8 pt-5 lg:px-7">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-bold">{snapshot.study.title}</h2>
                <span className="rounded bg-[#e9eee1] px-2 py-1 text-[9px] font-semibold text-[#7a8a68]">
                  {snapshot.study.origin.kind === "setup" ? "編集局面" : "棋譜"}
                </span>
              </div>
              <p className="mt-1 text-[10px] text-[#929c87]">
                {snapshot.live
                  ? "ライブ対局をローカルで検討"
                  : `人間${4 - cpuCount}席・CPU${cpuCount}席`}{" "}
                · 持ち時間なし · 自動保存
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="quiet"
                onPress={() => setLibraryVisible(!libraryVisible)}
                isDisabled={!!editor}
              >
                保存した検討 ({session.library.length})
              </Button>
              <a
                href={`/api/studies/${encodeURIComponent(snapshot.study.id)}/export`}
                download
                className="rounded-lg border border-[#d9e1d0] bg-white px-3 py-2 text-xs font-semibold no-underline hover:bg-[#edf3e7]"
              >
                ファイルに保存 ↓
              </a>
            </div>
          </div>
          {libraryVisible ? (
            <Panel title="保存した検討">
              <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {session.library.map((entry) => (
                  <button
                    key={entry.id}
                    className={`rounded-lg border p-3 text-left ${snapshot.study.id === entry.id ? "border-[#8aa773] bg-[#eef3e5]" : "border-[#e3e8dc] bg-[#fafcf7]"}`}
                    disabled={session.pending}
                    onClick={() => {
                      void session.open(entry.id).then((ok) => {
                        if (ok) setLibraryVisible(false);
                      });
                    }}
                  >
                    <span className="block truncate text-xs font-semibold">{entry.title}</span>
                    <span className="mt-1 block text-[10px] text-[#919d85]">
                      {new Date(entry.updatedAt).toLocaleString("ja-JP")} · CPU{" "}
                      {entry.cpuSides
                        ? entry.cpuSides.map((side) => sideNames[side]).join("・") || "なし"
                        : sideNames[entry.cpuSide]}
                    </span>
                  </button>
                ))}
              </div>
            </Panel>
          ) : null}
          <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[200px_minmax(0,1fr)_310px]">
            <div className="order-3 2xl:order-1">
              <HistoryPanel
                snapshot={snapshot}
                pending={session.pending || !!editor}
                select={select}
                previous={previous}
                next={next}
                canPrevious={path.length > 1}
                canNext={!!nextNode}
              />
            </div>
            <section className="order-1 min-w-0 2xl:order-2">
              <div className="overflow-hidden rounded-2xl border border-[#dce3d2] bg-[#fcfdf9] shadow-[0_5px_25px_#4c603209]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e5eade] px-4 py-3">
                  <div className="inline-flex gap-1 rounded-lg bg-[#eef2e6] p-1">
                    {(
                      [
                        ["auto", "対局"],
                        ["analysis", "検討"],
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        className={`rounded-md px-4 py-1.5 text-xs font-semibold ${snapshot.study.settings.mode === mode ? "bg-white text-[#3e6036] shadow-sm" : "text-[#8c9980]"}`}
                        disabled={session.pending || !!editor}
                        aria-pressed={snapshot.study.settings.mode === mode}
                        onClick={() =>
                          void session.command({ type: "settings", settings: { mode } })
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="quiet"
                      className="!min-h-8 !py-1"
                      isDisabled={session.pending || !!editor}
                      onPress={() =>
                        setViewerSide(sideOrder[(sideOrder.indexOf(viewerSide) + 1) % 4])
                      }
                    >
                      ↻ 回転
                    </Button>
                    <Button
                      variant="quiet"
                      className="!min-h-8 !py-1"
                      isDisabled={session.pending || !!editor}
                      onPress={() => void beginEditing()}
                    >
                      局面編集
                    </Button>
                  </div>
                </div>
                <div className="flex items-center justify-between px-5 pb-1 pt-4">
                  <span className="flex items-center gap-2 text-xs font-semibold">
                    <span
                      className="size-2 rounded-full"
                      style={{
                        background: editor
                          ? "#bc954e"
                          : state.turn
                            ? sideColors[state.turn]
                            : "#90a17c",
                      }}
                    />
                    {turnLabel}
                    {!editor && cpuTurn ? (
                      <span className="text-[10px] font-normal text-[#8f9c82]">
                        CPU{snapshot.analysis?.status === "running" ? "が思考しています" : ""}
                      </span>
                    ) : null}
                  </span>
                  <span className="font-mono text-[10px] text-[#a0aa94]">
                    {editor ? "新しい開始局面" : `${state.moveNumber}手目`}
                  </span>
                </div>
                <div className="h-[600px] max-h-[calc(100dvh-250px)] min-h-[420px] w-full [container-type:size] [--board-min-size:140px] [@media(max-width:767px)]:h-[610px] [@media(max-width:767px)]:max-h-none">
                  <FourShogiBoardLayout
                    game={board}
                    viewerSide={viewerSide}
                    interactionSide={state.turn ?? snapshot.study.cpuSide}
                    revision={`${snapshot.study.id}:${snapshot.study.revision}:${editor ? "edit" : "play"}`}
                    canPlay={
                      session.connected && !session.pending && !editor && (manual || !cpuTurn)
                    }
                    legalActions={snapshot.legalActions}
                    threePlayerAttackForbiddenActions={snapshot.forbiddenActions}
                    checkState={editor ? undefined : checks}
                    editing={
                      editor
                        ? {
                            selected: editor.selected,
                            onSelect: (position) => setEditor(editSquare(editor, position)),
                          }
                        : undefined
                    }
                    onAction={(action) => {
                      if (session.pending) return false;
                      const legal = snapshot.legalActions.find(
                        (candidate) => JSON.stringify(candidate) === JSON.stringify(action),
                      );
                      if (!legal) return false;
                      void session.command({ type: "action", action: legal });
                      return true;
                    }}
                    playerCards={Object.fromEntries(
                      sideOrder.map((side) => [
                        side,
                        <div
                          key={side}
                          className={`flex h-[var(--player-height)] items-center justify-between gap-2 rounded-xl border px-3 text-xs ${board.turn === side ? "border-[#b8c99f] bg-[#f1f5e9]" : "border-[#e3e8dc] bg-white"}`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span
                                className="size-1.5 shrink-0 rounded-full"
                                style={{ background: sideColors[side] }}
                              />
                              <strong>{sideNames[side]}</strong>
                              <span className="text-[9px] text-[#97a18b]">
                                {snapshot.live
                                  ? "対局者"
                                  : snapshot.study.settings.seats[side].controller === "cpu"
                                    ? "CPU"
                                    : "人間"}
                              </span>
                            </div>
                            <p className="mt-1 text-[9px] text-[#95a187]">
                              {board.eliminations.some((entry) => entry.side === side)
                                ? "脱落"
                                : !editor && checks?.[side]
                                  ? "王手"
                                  : snapshot.study.settings.seats[side].controller === "cpu"
                                    ? "単独優勝を目指す"
                                    : "あなたが操作"}
                            </p>
                          </div>
                          <span className="font-mono text-xs font-semibold tabular-nums">
                            {editor ? "—" : scoreLabel(evaluation, side, evaluationContext)}
                          </span>
                        </div>,
                      ]),
                    )}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e6ebdf] bg-[#f6f8f1] px-5 py-3">
                  <span className="text-[11px] text-[#8e9c7f]">
                    {editor
                      ? "駒を配置したら、右の「検討開始」で保存します。"
                      : state.status === "finished"
                        ? "終局しました。棋譜から戻って別の手を試せます。"
                        : manual
                          ? "全席の合法手を試せます。候補手から分岐を作ることもできます。"
                          : waiting
                            ? "CPUの自動着手は停止中です。再開するとCPUの手番で探索します。"
                            : `各席の指定時間でCPU自動着手 · 人間${4 - cpuCount}席はあなたが操作します。`}
                  </span>
                  {!editor && !manual && state.status === "playing" ? (
                    <Button
                      variant={waiting ? "primary" : "secondary"}
                      className="!min-h-8 !py-1"
                      isDisabled={session.pending}
                      onPress={() =>
                        void session.command({ type: waiting ? "resumePlay" : "pausePlay" })
                      }
                    >
                      {waiting ? "▶ 対局を再開" : "Ⅱ 自動着手を停止"}
                    </Button>
                  ) : null}
                </div>
              </div>
              {!editor ? (
                <div className="mt-4 space-y-4">
                  {snapshot.live ? <LivePanel snapshot={snapshot} session={session} /> : null}
                  <CommentPanel
                    key={`${snapshot.study.id}:${snapshot.study.currentNodeId}`}
                    snapshot={snapshot}
                    session={session}
                  />
                  <EngagementPanel state={state} cpuSide={snapshot.study.cpuSide} />
                </div>
              ) : null}
            </section>
            <div className="order-2 2xl:order-3">
              {editor ? (
                <PositionEditor
                  editor={editor}
                  setEditor={setEditor}
                  busy={session.pending}
                  cancel={() => setEditor(null)}
                  save={async (setup, title) => {
                    const ok = await session.command({ type: "setup", setup, title });
                    if (ok) setEditor(null);
                    return ok;
                  }}
                />
              ) : (
                <EvaluationPanel
                  snapshot={snapshot}
                  pending={session.pending}
                  analyze={session.analyze}
                  select={select}
                  command={session.command}
                />
              )}
            </div>
          </div>
          <footer className="mt-7 flex justify-between border-t border-[#e0e7d6] pt-4 text-[9px] text-[#9ca88f]">
            <span>四人将棋 検討室 · ローカル保存</span>
            <span>← → 棋譜を移動 · Esc 選択を解除</span>
          </footer>
        </main>
      )}
      {dialog === "new" ? (
        <NewStudyDialog session={session} close={() => setDialog(null)} />
      ) : dialog === "import" ? (
        <ImportDialog session={session} close={() => setDialog(null)} />
      ) : dialog === "live" ? (
        <LiveDialog session={session} close={() => setDialog(null)} />
      ) : dialog === "settings" && snapshot ? (
        <SettingsDialog key={snapshot.study.id} session={session} close={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function HistoryPanel({
  snapshot,
  pending,
  select,
  previous,
  next,
  canPrevious,
  canNext,
}: {
  snapshot: StudySnapshot;
  pending: boolean;
  select(id: string): void;
  previous(): void;
  next(): void;
  canPrevious: boolean;
  canNext: boolean;
}) {
  const [limit, setLimit] = useState(500);
  const tree = useMemo(() => orderedTree(snapshot.study.nodes), [snapshot.study.nodes]);
  const labels = useMemo(
    () => new Map(snapshot.history.map((entry) => [entry.id, entry.label])),
    [snapshot.history],
  );
  const selectedIndex = tree.findIndex((entry) => entry.node.id === snapshot.study.currentNodeId);
  const shown = tree.slice(0, Math.max(limit, selectedIndex + 1));
  useEffect(() => {
    document.querySelector('[data-history-current="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [snapshot.study.currentNodeId]);
  return (
    <Panel
      title="棋譜と分岐"
      eyebrow="MOVES & VARIATIONS"
      action={
        <span className="text-[10px] text-[#9ba68f]">{snapshot.study.nodes.length - 1}手</span>
      }
    >
      <div className="mb-3 flex gap-1">
        <Button
          className="flex-1 !min-h-7 !px-1 !py-1"
          isDisabled={pending || !canPrevious}
          aria-label="開始局面へ"
          onPress={() => select(tree[0].node.id)}
        >
          ⇤
        </Button>
        <Button
          className="flex-1 !min-h-7 !px-1 !py-1"
          isDisabled={pending || !canPrevious}
          aria-label="1手戻る"
          onPress={previous}
        >
          ←
        </Button>
        <Button
          className="flex-1 !min-h-7 !px-1 !py-1"
          isDisabled={pending || !canNext}
          aria-label="1手進む"
          onPress={next}
        >
          →
        </Button>
      </div>
      <div className="max-h-[670px] overflow-y-auto">
        <ol className="m-0 list-none space-y-0.5 p-0">
          {shown.map(({ node, level, branch }) => (
            <li key={node.id}>
              <button
                data-history-current={node.id === snapshot.study.currentNodeId ? "true" : undefined}
                aria-current={node.id === snapshot.study.currentNodeId ? "step" : undefined}
                disabled={pending}
                className={`w-full rounded-lg py-2 pr-2 text-left text-[11px] transition-colors ${node.id === snapshot.study.currentNodeId ? "bg-[#eaf0df] font-bold text-[#4b713b]" : "text-[#839173] hover:bg-[#f3f6ed]"}`}
                style={{ paddingLeft: `${8 + Math.min(level, 5) * 10}px` }}
                onClick={() => select(node.id)}
              >
                {branch ? <span className="mr-1.5 text-[#a6b19b]">↳</span> : null}
                {labels.get(node.id) ?? (node.parentId ? "着手" : "開始局面")}
              </button>
            </li>
          ))}
        </ol>
        {shown.length < tree.length ? (
          <Button variant="quiet" className="mt-2 w-full" onPress={() => setLimit(limit + 500)}>
            続きの棋譜を表示
          </Button>
        ) : null}
      </div>
      <p className="mt-4 text-[10px] leading-relaxed text-[#a0aa94]">
        過去の局面で手を指すと、
        <br />
        元の続きを残して分岐します。
      </p>
    </Panel>
  );
}
function EngagementPanel({ state, cpuSide }: { state: FourShogiState; cpuSide: Side }) {
  const relations = state.attackRelations.filter(
    (relation) => relation.attacker !== relation.target,
  );
  const reasonLabels = {
    check: "王手",
    capture: "駒取り",
    threat: "駒への圧力",
    blockade: "進路の封鎖",
  };
  return (
    <Panel title="盤上の攻防" eyebrow="BOARD RELATIONS">
      <div className="flex flex-wrap items-center gap-2">
        {relations.length ? (
          relations.map((relation, index) => (
            <span
              key={index}
              className="inline-flex items-center gap-2 rounded-lg border border-[#e2e8d9] bg-[#f9fbf5] px-3 py-2 text-[10px]"
            >
              <span style={{ color: sideColors[relation.attacker] }}>
                {sideNames[relation.attacker]}
                {relation.attacker === cpuSide ? "（視点）" : ""}
              </span>
              <span className="text-[#abb59e]">→</span>
              <span style={{ color: sideColors[relation.target] }}>
                {sideNames[relation.target]}
              </span>
              <span className="text-[#a2ad95]">
                {relation.reasons.map((reason) => reasonLabels[reason]).join("・")}
              </span>
            </span>
          ))
        ) : (
          <p className="text-xs text-[#98a38c]">現在、記録されている攻撃関係はありません。</p>
        )}
      </div>
      <p className="mt-3 text-[10px] text-[#a3ad98]">
        ルール上の攻撃関係を表示しています。
        {state.threePlayerAttackProhibited ? "三人攻撃禁止：有効" : "三人攻撃禁止：無効"}
      </p>
    </Panel>
  );
}

function CommentPanel({ snapshot, session }: { snapshot: StudySnapshot; session: StudySession }) {
  const saved =
    snapshot.study.nodes.find((node) => node.id === snapshot.study.currentNodeId)?.comment ?? "";
  const [comment, setComment] = useState(saved);
  const [baseComment, setBaseComment] = useState(saved);
  const changedElsewhere = saved !== baseComment;
  return (
    <Panel title="局面のコメント">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (changedElsewhere) return;
          void session
            .command({ type: "comment", nodeId: snapshot.study.currentNodeId, comment })
            .then((ok) => {
              if (ok) setBaseComment(comment);
            });
        }}
      >
        {changedElsewhere ? (
          <p role="alert" className="mb-2 text-xs text-[#a95042]">
            コメントが別の操作で更新されました。
            <Button
              onPress={() => {
                setComment(saved);
                setBaseComment(saved);
              }}
            >
              コメントを読み直す
            </Button>
          </p>
        ) : null}
        <Field label="検討メモ">
          <textarea
            className={fieldClass}
            maxLength={10000}
            rows={3}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </Field>
        <Button
          type="submit"
          className="mt-2"
          isDisabled={session.pending || comment === saved || changedElsewhere}
        >
          コメントを保存
        </Button>
      </form>
    </Panel>
  );
}

function LivePanel({ snapshot, session }: { snapshot: StudySnapshot; session: StudySession }) {
  const live = snapshot.live!;
  const labels = {
    connecting: "接続中",
    syncing: "履歴を同期中",
    live: "観戦中",
    reconnecting: "再接続中",
    finished: "終局",
    closed: "切断済み",
    error: "接続エラー",
  };
  return (
    <Panel title="ライブ対局" action={<span className="text-xs">{labels[live.status]}</span>}>
      <div className="mb-4">
        <FocusSelector
          side={snapshot.study.settings.focusSide ?? null}
          pending={session.pending}
          onChange={(focusSide) =>
            void session.command({ type: "settings", settings: { focusSide } })
          }
        />
        {snapshot.study.settings.focusSide ? (
          <p className="mt-2 text-xs text-[#52734c]">
            {sideNames[snapshot.study.settings.focusSide]}にフォーカス ·
            他の人の着手後もこの席の次手番を検討します
          </p>
        ) : null}
      </div>
      <p className="text-xs">
        取得済み {live.eventCount}イベント · {live.follow ? "最新局面に追従" : "局面を固定して検討"}
      </p>
      <p className="mt-2 text-xs">
        表示局面 {snapshot.position.stateHash.slice(0, 12)} ·{" "}
        {snapshot.analysis?.stateHash === snapshot.position.stateHash
          ? "解析の元局面と一致"
          : "現在局面の解析は未確認"}
      </p>
      {live.follow && (!session.connected || !["live", "finished"].includes(live.status)) ? (
        <p role="status" className="mt-2 text-xs">
          最新の履歴・接続を確認できるまで推奨手を非表示にします。
        </p>
      ) : null}
      <a
        className="mt-2 block break-all text-xs text-[#52734c]"
        href={live.sourceUrl}
        target="_blank"
        rel="noreferrer"
      >
        対局を開く
      </a>
      {live.message ? (
        <p role={live.status === "error" ? "alert" : "status"} className="mt-2 text-xs">
          {live.message}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          isDisabled={session.pending || ["closed", "error"].includes(live.status)}
          onPress={() => void session.command({ type: "liveFollow", enabled: !live.follow })}
        >
          {live.follow ? "局面を固定" : "最新局面に追従"}
        </Button>
        <Button
          isDisabled={session.pending}
          onPress={() => void session.command({ type: "liveReconnect" })}
        >
          再接続
        </Button>
        <Button
          isDisabled={session.pending || live.status === "closed"}
          onPress={() => void session.command({ type: "liveDisconnect" })}
        >
          観戦を切断
        </Button>
        {live.nextStudyId ? (
          <Button onPress={() => void session.open(live.nextStudyId!)}>新しい対局を開く</Button>
        ) : null}
      </div>
    </Panel>
  );
}
