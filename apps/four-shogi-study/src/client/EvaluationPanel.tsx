import type { StudySnapshot } from "../contracts";
import { Button, Panel } from "./ui";
import { FocusSelector } from "./FocusSelector";
import {
  actionLabel,
  ancestorIds,
  lineLabel,
  scoreLabel,
  rankLabel,
  scoreValue,
  sideColors,
  sideNames,
  sideOrder,
  type EvaluationContext,
} from "./presentation";
import type { AnalysisInput, CommandInput } from "./api";
import type { StudyCandidate } from "@tetraboard/four-shogi/study-search";
import type { Side } from "@tetraboard/four-shogi";

export function EvaluationPanel({
  snapshot,
  pending,
  analyze,
  select,
  command,
}: {
  snapshot: StudySnapshot;
  pending: boolean;
  analyze(command: AnalysisInput): Promise<boolean>;
  select(id: string): void;
  command(input: CommandInput): Promise<boolean>;
}) {
  const { study, analysis, staticEvaluation } = snapshot;
  const evaluation = analysis?.evaluation ?? staticEvaluation;
  const evaluationContext: EvaluationContext = analysis?.evaluation
    ? { source: "line", position: snapshot.position.state }
    : { source: "position" };
  const maximum = Math.max(
    500,
    ...sideOrder.map((side) => Math.abs(scoreValue(evaluation, side) ?? 0)),
  );
  const searching = analysis?.status === "running";
  const manual = study.settings.mode === "analysis";
  const focus = analysis?.focus;
  const prefix = focus?.prefix ?? [];
  const rootSide = focus?.side ?? snapshot.position.state.turn ?? study.cpuSide;
  const future = prefix.length > 0;
  const signature = (
    candidate: NonNullable<typeof analysis>["candidates"][number],
    plies: number,
  ) =>
    JSON.stringify(
      [...prefix, ...candidate.line.slice(0, plies)].map(({ side, action }) => ({ side, action })),
    );
  return (
    <aside className="flex min-w-0 flex-col gap-4">
      {!snapshot.live ? (
        <Panel title="検討のフォーカス">
          <FocusSelector
            side={study.settings.focusSide ?? null}
            pending={pending || study.playEnabled}
            onChange={(focusSide) => void command({ type: "settings", settings: { focusSide } })}
          />
        </Panel>
      ) : null}
      {study.settings.focusSide && !study.playEnabled ? (
        <Panel title={`${sideNames[study.settings.focusSide]}の次手番を検討`}>
          <p role="status" className="text-xs leading-relaxed text-[#52734c]">
            {focus?.status === "ready"
              ? future
                ? `相手の予測${prefix.length}手を前提に、${sideNames[focus.side]}の次手番を検討しています。実際の着手が変わると再計算します。`
                : "現在がフォーカスした席の手番です。"
              : focus?.status === "focus_eliminated"
                ? future
                  ? "予測手順の途中でフォーカスした席が脱落し、次手番に到達しませんでした。"
                  : "フォーカスした席はすでに脱落しているため、次手番を検討できません。"
                : focus?.status === "terminal"
                  ? future
                    ? "予測手順が終局に至り、フォーカスした席の次手番には到達しませんでした。"
                    : "対局は終局しています。フォーカスした席の次手番はありません。"
                  : focus?.status === "unreached"
                    ? "読んだ範囲では次手番に到達していません。予測手順を確認し、再解析できます。"
                    : focus?.status === "cancelled"
                      ? "フォーカスの検討を停止しています。"
                      : focus?.status === "error"
                        ? "次手番までの予測に失敗しました。再解析してください。"
                        : analysis?.status === "running"
                          ? "フォーカスした席までの手順を予測しています。"
                          : "検討を開始すると、指定した席の次手番の候補を表示します。"}
          </p>
          {prefix.length ? (
            <details className="mt-3 text-xs text-[#758469]">
              <summary className="cursor-pointer">次手番までの相手の予測</summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                {prefix.map((step, index) => (
                  <li key={index}>{lineLabel(step)}</li>
                ))}
              </ol>
              <p className="mt-2">この手順は予測です。相手の着手を確定したものではありません。</p>
            </details>
          ) : null}
        </Panel>
      ) : null}
      <Panel
        title="局面の評価"
        eyebrow="POSITION EVALUATION"
        action={
          <span className="rounded-full bg-[#edf2e9] px-2 py-1 text-[10px] text-[#6d7d61]">
            {analysis?.evaluation ? "読み筋末尾の予想" : "元局面の静的評価"}
          </span>
        }
      >
        <div className="space-y-3">
          {sideOrder.map((side) => (
            <div key={side}>
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded-full" style={{ background: sideColors[side] }} />
                  {sideNames[side]}{" "}
                  {study.settings.focusSide === side ? (
                    <span className="rounded bg-[#e6eee7] px-1.5 py-0.5 text-[9px]">
                      フォーカス
                    </span>
                  ) : null}
                  {!snapshot.live && study.settings.seats[side].controller === "cpu" ? (
                    <span className="rounded bg-[#e8eee3] px-1.5 py-0.5 text-[9px] font-bold text-[#4a6541]">
                      CPU
                    </span>
                  ) : (
                    <span className="text-[#8a9482]">{snapshot.live ? "対局者" : "人間"}</span>
                  )}
                </span>
                <strong className="font-mono text-base tabular-nums">
                  {scoreLabel(evaluation, side, evaluationContext)}
                </strong>
              </div>
              <p className="mb-1 text-[10px] text-[#8a9482]">
                {rankLabel(evaluation, side, evaluationContext)}
              </p>
              <div className="relative h-1.5 overflow-hidden rounded bg-[#eef1e9]">
                <span className="absolute left-1/2 h-full w-px bg-[#cdd6c4]" />
                <span
                  className="absolute h-full rounded"
                  style={{
                    background: sideColors[side],
                    left: `${50 + Math.min(0, ((scoreValue(evaluation, side) ?? 0) / maximum) * 50)}%`,
                    width: `${Math.min(50, (Math.abs(scoreValue(evaluation, side) ?? 0) / maximum) * 50)}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[10px] leading-relaxed text-[#8a9481]">
          点数は勝率ではありません。表示中の盤面で決まった順位を「確定」、元局面の静的順位を「暫定」、読み筋末尾の順位を「予想」と表示します。
        </p>
      </Panel>
      <Panel
        title="探索"
        eyebrow="SEARCH"
        action={
          <span
            className={`flex items-center gap-1.5 text-[10px] ${searching ? "text-[#42714d]" : "text-[#8b9583]"}`}
          >
            <span
              className={`size-1.5 rounded-full ${searching ? "animate-pulse bg-[#59885f]" : "bg-[#b8c2b0]"}`}
            />
            {searching
              ? "思考中"
              : analysis?.status === "paused"
                ? "一時停止"
                : analysis?.status === "completed"
                  ? "完了"
                  : "待機"}
          </span>
        }
      >
        <div className="grid grid-cols-3 gap-2 text-center">
          <Metric label="比較深さ" value={String(analysis?.completedDepth ?? 0)} />
          <Metric label="探索局面" value={(analysis?.nodes ?? 0).toLocaleString("ja-JP")} />
          <Metric label="経過" value={`${((analysis?.elapsedMs ?? 0) / 1000).toFixed(1)}秒`} />
        </div>
        {analysis?.performance ? (
          <div className="mt-3 text-[10px] leading-relaxed text-[#758469]">
            <p>
              {searching
                ? `深さ${analysis.performance.iterationDepth}を検討中`
                : "最後に完成した候補比較を表示"}
              {analysis.performance.totalTasks > 0
                ? ` · ${analysis.performance.completedTasks}/${analysis.performance.totalTasks}候補完了`
                : ""}
            </p>
            <p>候補・静かな枝を絞る選択探索です。全合法手を網羅した深さではありません。</p>
            <details className="mt-2">
              <summary className="cursor-pointer">探索の処理内訳</summary>
              <p>
                合法手生成 {(analysis.performance.legalMs / 1000).toFixed(2)}秒 · 局面確定{" "}
                {(analysis.performance.transitionMs / 1000).toFixed(2)}秒
              </p>
              <p>
                評価 {(analysis.performance.evaluationMs / 1000).toFixed(2)}秒 · 手の並べ替え{" "}
                {(analysis.performance.orderingMs / 1000).toFixed(2)}秒
              </p>
              <p>各プロセスの計測合計です。並列実行のため経過時間とは異なります。</p>
              <p>
                探索結果の再利用 {analysis.performance.branchCacheHits.toLocaleString()}回 ·
                キャッシュ入替 {analysis.performance.cacheEvictions.toLocaleString()}回
              </p>
              <p>
                静かな枝の浅い確認 {analysis.performance.reducedNodes.toLocaleString()}回 · 再探索{" "}
                {analysis.performance.researches.toLocaleString()}回
              </p>
              <ol className="list-inside list-decimal">
                {analysis.performance.depths.map((entry) => (
                  <li key={entry.depth}>
                    深さ{entry.depth} · {(entry.elapsedMs / 1000).toFixed(2)}秒 · {entry.roots}候補
                  </li>
                ))}
              </ol>
            </details>
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-between text-[10px] text-[#8c9685]">
          <span>
            {study.settings.threads}プロセス · {study.settings.memoryMb.toLocaleString()} MBまで
          </span>
          <span>使用 {Math.round((analysis?.memoryBytes ?? 0) / 1024 / 1024)} MB</span>
        </div>
        <div className="mt-4 flex gap-2">
          {searching ? (
            <Button
              isDisabled={pending}
              className="flex-1"
              onPress={() => void analyze({ command: "pause" })}
            >
              探索を停止
            </Button>
          ) : (
            <Button
              variant="primary"
              isDisabled={pending || snapshot.position.state.status !== "playing"}
              className="flex-1"
              onPress={() => void analyze({ command: "start" })}
            >
              {analysis ? "再解析" : manual ? "この局面を検討" : "探索する"}
            </Button>
          )}
          {analysis?.recommendedAction ? (
            <Button
              isDisabled={pending || analysis.completedDepth < 1}
              className="flex-1"
              onPress={() =>
                void analyze({
                  command: "adopt",
                  analysisId: analysis.id,
                  stateHash: analysis.stateHash,
                  action: analysis.recommendedAction!,
                })
              }
            >
              推奨手を指す
            </Button>
          ) : null}
        </div>
        <p className="mt-3 text-[10px] text-[#8c9685]">
          検討時間：
          {study.settings.analysisTimeMs === null
            ? "停止するまで"
            : `${study.settings.analysisTimeMs / 1000}秒`}
        </p>
        {analysis?.saved ? (
          <p className="mt-2 break-all text-[10px] text-[#8c9685]">
            保存済み · {analysis.saved.searchVersion} / {analysis.saved.evaluationVersion} ·
            保存時：
            {analysis.saved.timeBudgetMs === null
              ? "無制限"
              : `${analysis.saved.timeBudgetMs / 1000}秒`}{" "}
            / {analysis.saved.threads}プロセス / {analysis.saved.memoryMb}MiB
          </p>
        ) : null}
        {analysis?.reason ? (
          <p
            role={analysis.status === "error" ? "alert" : "status"}
            className="mt-3 text-xs text-[#758469]"
          >
            {stopLabel(analysis.reason)}
          </p>
        ) : null}
      </Panel>
      <Panel title="候補手" eyebrow="CANDIDATES">
        {!analysis?.candidates.length ? (
          <p className="py-4 text-center text-xs leading-relaxed text-[#99a18f]">
            探索を始めると、候補手と
            <br />
            予想手順が表示されます。
          </p>
        ) : (
          <ol className="m-0 list-none space-y-2 p-0">
            {analysis.candidates.slice(0, 5).map((candidate, index) => (
              <li
                key={JSON.stringify(candidate.action)}
                className="rounded-lg border border-[#e5e9df] p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span className="grid size-5 place-items-center rounded bg-[#eef2e8] text-[10px] text-[#758769]">
                      {index + 1}
                    </span>
                    <strong className="text-sm">
                      {future && candidate.line[0]
                        ? lineLabel(candidate.line[0])
                        : actionLabel(candidate.action, snapshot.position.state)}
                    </strong>
                  </span>
                  <span className="font-mono text-xs">
                    {scoreLabel(candidate.evaluation, rootSide, {
                      source: "line",
                      position: snapshot.position.state,
                    })}
                  </span>
                </div>
                <p className="mt-2 text-[10px] text-[#85917c]">
                  深さ {candidate.completedDepth} · {sideNames[rootSide]}視点
                  {future ? " · 次手番の条件付き候補" : ""}
                  {candidate.selective ? " · 選択探索" : ""}
                  {` · この予想手順では次の自手${Math.max(0, candidate.line.filter((step) => step.side === rootSide).length - 1)}回まで到達`}
                </p>
                <details className="mt-2 text-[11px]">
                  <summary className="cursor-pointer text-[#607252]">予想手順・危険の確認</summary>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-[#6e7a63]">
                    {candidate.line.slice(0, 32).map((step, ply) => (
                      <li key={ply}>
                        <button
                          className="text-left underline decoration-dotted underline-offset-2 disabled:opacity-50"
                          disabled={pending}
                          onClick={() =>
                            void command({
                              type: "variation",
                              analysisId: analysis.id,
                              stateHash: analysis.stateHash,
                              candidateIndex: index,
                              plies: ply + 1,
                              lineSignature: signature(candidate, ply + 1),
                            })
                          }
                        >
                          {lineLabel(step)}（ここまで盤面で確認）
                        </button>
                        {step.captured
                          ? `・${sideNames[step.captured.side]}の${step.captured.kind === "rook" ? "飛車" : "駒"}を取る`
                          : ""}
                        {step.checkedSides.length
                          ? `・${step.checkedSides.map((side) => sideNames[side]).join("/")}へ王手`
                          : ""}
                      </li>
                    ))}
                  </ol>
                  <TacticalNotes candidate={candidate as Partial<StudyCandidate>} />
                  {candidate.danger.alternatives?.eliminationWitness ? (
                    <p className="mt-2 text-[#ac5947]">別の応手で脱落する手順があります。</p>
                  ) : null}
                  {candidate.danger.alternatives?.rookLossWitness ? (
                    <p className="mt-2 text-[#aa7738]">別の応手で飛車を失う手順があります。</p>
                  ) : null}
                  <p className="mt-2 text-[10px] text-[#939b89]">
                    予想手順は一例です。
                    {candidate.danger.alternatives?.complete
                      ? "次の実自手番までの指定範囲の検査が完了しました。その先の安全は未確定です。"
                      : "危険な応手の確認は探索範囲内です。"}
                  </p>
                </details>
                <Button
                  variant="quiet"
                  className="mt-2 w-full !min-h-7 !py-1 text-[10px]"
                  isDisabled={pending}
                  onPress={() =>
                    future
                      ? void command({
                          type: "variation",
                          analysisId: analysis.id,
                          stateHash: analysis.stateHash,
                          candidateIndex: index,
                          plies: 1,
                          lineSignature: signature(candidate, 1),
                        })
                      : void analyze({
                          command: "adopt",
                          analysisId: analysis.id,
                          stateHash: analysis.stateHash,
                          action: candidate.action,
                        })
                  }
                >
                  {future ? "予測手順とこの手を分岐で確認 →" : "この手を試す →"}
                </Button>
              </li>
            ))}
          </ol>
        )}
      </Panel>
      <Panel title="各陣営の次の手番の予想">
        <p className="mb-3 text-[10px] text-[#8a9481]">
          最上位候補の予想進行に基づきます。相手の応手によって変わります。
        </p>
        <ul className="space-y-2 text-xs">
          {sideOrder.map((side) => {
            const line = [...prefix, ...(analysis?.candidates[0]?.line ?? [])];
            const step = line.find((entry) => entry.side === side);
            return (
              <li key={side}>
                <strong>{sideNames[side]}：</strong>
                {step
                  ? `${!future && side === snapshot.position.state.turn ? "現在の推奨" : `${line.indexOf(step) + 1}手目に手番が来る想定`} · ${lineLabel(step)}`
                  : "読んだ範囲では手番なし／未解析"}
              </li>
            );
          })}
        </ul>
      </Panel>
      <EvaluationGraph snapshot={snapshot} select={select} />
    </aside>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[#f7f9f3] py-3">
      <p className="text-[9px] text-[#89967d]">{label}</p>
      <p className="mt-1 font-mono text-sm font-semibold">{value}</p>
    </div>
  );
}
function EvaluationGraph({
  snapshot,
  select,
}: {
  snapshot: StudySnapshot;
  select(id: string): void;
}) {
  const ids = ancestorIds(snapshot.study.nodes, snapshot.study.currentNodeId);
  const targetSide = snapshot.study.settings.focusSide ?? snapshot.study.cpuSide;
  const history = new Map(snapshot.history.map((entry) => [entry.id, entry]));
  const entries = ids.map((id) => history.get(id)).filter((entry) => entry !== undefined);
  const width = 260,
    height = 100;
  const maximum = Math.max(
    1000,
    ...entries.flatMap((entry) =>
      sideOrder.map((side) => Math.abs(scoreValue(entry.evaluation, side) ?? 0)),
    ),
  );
  const x = (index: number) => 8 + (index / Math.max(1, entries.length - 1)) * (width - 16);
  const y = (score: number) => height / 2 - (score / maximum) * (height / 2 - 10);
  return (
    <Panel title="評価の推移" eyebrow="SELECTED VARIATION">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="選択中の分岐における四者の評価推移"
        className="w-full overflow-visible"
      >
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="#dde4d6"
          strokeDasharray="3 3"
        />
        {sideOrder.map((side: Side) => (
          <polyline
            key={side}
            fill="none"
            stroke={sideColors[side]}
            strokeWidth={side === targetSide ? 2.5 : 1.2}
            opacity={side === targetSide ? 1 : 0.55}
            points={entries
              .map(
                (entry, index) =>
                  `${x(index).toFixed(1)},${y(scoreValue(entry.evaluation, side) ?? 0).toFixed(1)}`,
              )
              .join(" ")}
          />
        ))}
        {entries.map((entry, index) => (
          <circle
            key={entry.id}
            cx={x(index)}
            cy={y(scoreValue(entry.evaluation, targetSide) ?? 0)}
            r="5"
            fill={sideColors[targetSide]}
            fillOpacity="0.5"
            className="cursor-pointer"
            onClick={() => select(entry.id)}
          >
            <title>
              {entry.label}：{scoreLabel(entry.evaluation, targetSide, { source: "position" })}
            </title>
          </circle>
        ))}
      </svg>
      <p className="mt-2 text-[10px] text-[#939c89]">各局面の静的評価 · 棋譜から局面を選べます</p>
    </Panel>
  );
}

function stopLabel(reason: string) {
  const labels: Record<string, string> = {
    deadline: "指定時間に到達しました",
    memory_limit: "探索メモリの上限に到達したため停止しました",
    max_depth: "探索深さの上限に到達しました",
    sole_win:
      "単独勝ちに至る予想進行が見つかったため停止しました。相手の応手により結果は変わります。",
    cancelled: "探索を中止しました",
    focus_eliminated: "指定した席の次手番には到達しませんでした。脱落の状況を確認してください。",
    focus_terminal: "終局のため、指定した席の次手番はありません。",
    focus_unreached: "読んだ範囲では指定した席の次手番に到達しませんでした。",
    focus_cancelled: "指定した席への手順の予測を停止しました。",
  };
  return labels[reason] ?? reason;
}
function TacticalNotes({ candidate }: { candidate: Partial<StudyCandidate> }) {
  const study = candidate.study;
  if (!study) return null;
  return (
    <div className="mt-2 space-y-1 text-[10px] text-[#758469]">
      {study.magicEvidence ? (
        <p>
          {study.magicEvidence.status === "line_confirmed"
            ? `この読み筋ではマジックの手番復帰と利得を確認（${study.magicEvidence.returnedAtPly}手目）`
            : "マジック候補：手番復帰と交換後の損得を検討中"}
        </p>
      ) : null}
      <p>
        この読み筋の資産増減：{study.material.lineDelta >= 0 ? "+" : ""}
        {study.material.lineDelta}点（歩100点）
      </p>
      {study.material.lossWitness ? (
        <p className="text-[#aa7738]">別の合法応手で駒損となる手順があります。</p>
      ) : null}
      <p>
        {study.material.complete
          ? "次の実自手番までの駒損検査が完了。以後や省略した範囲の安全は未確定です。"
          : "駒損の別応手検査は未完了です。"}
      </p>
      {study.engagements.length ? (
        <p>
          駒取り・王手の圧力：
          {study.engagements
            .map((entry) => `${sideNames[entry.attacker]}→${sideNames[entry.target]}`)
            .join("、")}
          （AIの推定）
        </p>
      ) : null}
    </div>
  );
}
