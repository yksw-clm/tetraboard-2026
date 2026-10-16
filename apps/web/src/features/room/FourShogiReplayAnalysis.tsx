import { useContext, useState } from "react";
import { sides } from "@tetraboard/four-shogi";
import type { ReplayFourShogiMatch } from "@tetraboard/protocol";
import type { AiAnalysisEvaluation } from "@tetraboard/protocol/four-shogi-ai";
import { AppButton } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AccountContext } from "../account/useAccount";
import { shogiSideNames, shogiEliminationLabels } from "./fourShogiRoomPresentation";
import { shogiNotationPiece } from "./shogiNotation";
import { useReplayAnalysis } from "./useReplayAnalysis";
import {
  analysisBudgets,
  type AnalysisCandidateView,
  type AnalysisProfile,
} from "./fourShogiAnalysis";
import type { FourShogiReplayFrame } from "./fourShogiReplayV1";

function Evaluation({ value, label }: { value: AiAnalysisEvaluation; label: string }) {
  return (
    <table className="w-full text-xs text-left">
      <caption className="text-left font-bold">{label}</caption>
      <thead>
        <tr>
          <th>陣営</th>
          <th>探索指標</th>
          <th>順位</th>
        </tr>
      </thead>
      <tbody>
        {sides.map((side) => {
          const rank = value.ranks.find((r) => r.side === side)!;
          return (
            <tr key={side}>
              <th>{shogiSideNames[side]}</th>
              <td>{value.values[side].primary.toFixed(4)}</td>
              <td>
                {rank.rank}位（{rank.kind === "confirmed" ? "確定" : "暫定"}）
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
const boundaries = {
  returned: "次の自手番に到達",
  eliminated: "自分の脱落で終了",
  terminal: "終局まで",
  horizon: "次の自手番までは未読",
};
function Candidate({ view, title }: { view: AnalysisCandidateView; title: string }) {
  const { candidate, label, line } = view;
  return (
    <AppCard density="compact" className="space-y-2 text-xs">
      <h3 className="text-sm font-bold">
        {title}：{label}
      </h3>
      {candidate.evaluation ? (
        <Evaluation value={candidate.evaluation} label="この候補の探索評価" />
      ) : (
        <p>反復探索が完了せず、比較評価はありません。</p>
      )}
      <p>
        完了深さ {candidate.completedDepth}・候補の処理量 {candidate.iterationWork}／節点{" "}
        {candidate.iterationNodes}
        {candidate.selective ? "・候補幅に制限あり" : ""}
        {candidate.cutoff ? "・打切りあり" : ""}
      </p>
      <details>
        <summary>読み筋と予測される危険</summary>
        <p>各手番者が自身の勝利を目指す進行例です。応手や駒損・脱落が必然とは限りません。</p>
        {line.length ? (
          <ol className="pl-5 list-decimal">
            {line.map((text, i) => {
              const step = candidate.line[i];
              return (
                <li key={i}>
                  {text}
                  {step.captured
                    ? `／${shogiSideNames[step.captured.side]}の${shogiNotationPiece(step.captured)}を捕獲する予測`
                    : ""}
                  {step.checkedSides.length
                    ? `／王手の予測：${step.checkedSides.map((s) => shogiSideNames[s]).join("・")}`
                    : ""}
                  {step.eliminations
                    .map(
                      (e) =>
                        `／${shogiSideNames[e.side]}が${shogiEliminationLabels[e.reason]}する予測`,
                    )
                    .join("")}
                </li>
              );
            })}
          </ol>
        ) : (
          <p>読み筋を取得できる深さに達していません。</p>
        )}
        <p>
          次の自手番までの検査：{boundaries[candidate.danger.untilNextOwnTurn]}（進行例の
          {candidate.danger.evidence.length}手）。別の合法応手による危険は未検査です。
        </p>
        {candidate.lineEvaluation && (
          <Evaluation value={candidate.lineEvaluation} label="読み筋末尾の評価" />
        )}
      </details>
    </AppCard>
  );
}
function AnalysisPanel({
  match,
  frames,
  index,
}: {
  match: ReplayFourShogiMatch;
  frames: FourShogiReplayFrame[];
  index: number;
}) {
  const [profile, setProfile] = useState<AnalysisProfile>("trial-500ms");
  const state = useReplayAnalysis(match, frames, index);
  const result = state.analysis?.result;
  const checked = sides.filter((side) => frames[index].checkState[side]);
  return (
    <div className="space-y-3 text-sm">
      <p>
        現在の局面：{frames[index].label}（イベント位置 {index}）
      </p>
      <p>
        三人攻撃禁止 {match.replay.initial.threePlayerAttackProhibited ? "ON" : "OFF"}
        。評価視点はこの局面の手番者
        {frames[index].game.turn ? `・${shogiSideNames[frames[index].game.turn]}` : "（終局）"}
        です。
      </p>
      <p>
        現在の確定王手：{checked.length ? checked.map((s) => shogiSideNames[s]).join("・") : "なし"}
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="解析の思考予算">
        {(["trial-500ms", "trial-30000ms"] as const).map((key) => (
          <AppButton
            size="compact"
            appearance={profile === key ? "primary" : "secondary"}
            aria-pressed={profile === key}
            isDisabled={state.busy}
            key={key}
            onPress={() => setProfile(key)}
          >
            {key === "trial-500ms" ? "500ms" : "30秒"}
          </AppButton>
        ))}
      </div>
      <p className="text-xs">
        思考予算を増やした場合の棋力改善は未検証です。探索指標は未校正で、暫定順位には不確実性があります。
      </p>
      <div className="flex gap-2">
        <AppButton
          size="compact"
          isDisabled={state.busy}
          isPending={state.busy}
          onPress={() => void state.start(profile)}
        >
          この局面を解析
        </AppButton>
        {state.busy && (
          <AppButton size="compact" appearance="secondary" onPress={state.cancel}>
            解析を取消
          </AppButton>
        )}
      </div>
      <p role="status">
        {state.phase === "preparing"
          ? "局面と解析サービスを確認しています…"
          : state.phase === "queued"
            ? "解析の順番待ちです…"
            : state.phase === "running"
              ? "解析しています…"
              : state.phase === "cancelled"
                ? "解析を取り消しました。受付済みの処理には取消を依頼します。届かない場合はジョブ期限で終了します。"
                : state.phase === "completed"
                  ? "解析が完了しました。"
                  : ""}
      </p>
      {state.error && <p role="alert">{state.error}</p>}
      {result && state.analysis && (
        <>
          <p>推奨手：{state.analysis.candidates[0]?.label ?? "なし（終局または合法手なし）"}</p>
          {result.status === "limited" && (
            <p>
              計算上限で打ち切った暫定結果です。未探索の応手があり、候補の優劣が変わる可能性があります。
            </p>
          )}
          <p>
            候補比較は同じ根局面・モデル・予算・完了深さで行います。
            {result.candidates.length < 2
              ? "比較可能な候補は2手未満です。"
              : `上位${result.candidates.length}候補を表示します。`}
          </p>
          {result.evaluation && (
            <Evaluation
              value={result.evaluation}
              label={
                result.status === "terminal" ? "終局の4人評価" : "推奨手を進めた探索上の4人評価"
              }
            />
          )}
          {state.analysis.candidates.map((view, i) => (
            <Candidate key={i} view={view} title={`候補${i + 1}`} />
          ))}
          {state.analysis.actual ? (
            <Candidate view={state.analysis.actual} title="実際の着手（同じ条件で比較）" />
          ) : (
            <p>
              実際の着手との比較：
              {frames[index + 1]?.event?.type === "action"
                ? "評価できる反復探索が未完了です。"
                : "直後のイベントは着手ではないか、終局のため比較対象がありません。"}
            </p>
          )}
          <details>
            <summary>解析条件・計算量</summary>
            <dl className="text-xs break-all">
              <dt>根局面</dt>
              <dd>{result.input.stateHash}</dd>
              <dt>要求予算／実効探索予算</dt>
              <dd>
                {analysisBudgets[state.profile!].timeBudgetMs}ms／
                {result.settings.timeBudgetMs.toFixed(1)}ms・上限{result.settings.maxWork}work
              </dd>
              <dt>完了深さ／処理量／探索時間</dt>
              <dd>
                {result.diagnostics.completedDepth}／{result.diagnostics.work}work／
                {result.diagnostics.elapsedMs.toFixed(1)}ms
              </dd>
              <dt>停止理由／期限超過</dt>
              <dd>
                {result.diagnostics.stopReason}／{result.diagnostics.deadlineOverrunMs.toFixed(1)}ms
              </dd>
              <dt>モデル</dt>
              <dd>{state.modelId}</dd>
              <dt>コード</dt>
              <dd>{state.codeVersion}</dd>
              <dt>解析・探索・評価・ルール版</dt>
              <dd>
                {result.versions.analysisVersion}／{result.versions.searchVersion}／
                {result.versions.evaluationVersion}／{result.versions.engineVersion}
              </dd>
            </dl>
          </details>
          <p className="text-xs">
            解析は候補幅を制限した探索です。保存棋譜・実際の勝敗・戦績は変更しません。
          </p>
        </>
      )}
    </div>
  );
}
export function FourShogiReplayAnalysis({
  match,
  frames,
  index,
  select,
}: {
  match: ReplayFourShogiMatch;
  frames: FourShogiReplayFrame[];
  index: number;
  select: (index: number) => void;
}) {
  const account = useContext(AccountContext);
  const [open, setOpen] = useState(false);
  const origin = location.origin;
  const trial =
    origin === "https://tetraboard-dev.chaossi-lab.workers.dev" ||
    (location.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname));
  if (
    !trial ||
    !account?.user?.profileCompleted ||
    account.loading ||
    account.error ||
    match.settings.mode !== "singles" ||
    match.game.status !== "finished"
  )
    return null;
  return (
    <>
      <AppButton
        size="compact"
        appearance="secondary"
        className="h-7 min-h-7 px-1 text-xs"
        onPress={() => setOpen(true)}
      >
        解析（試用）
      </AppButton>
      {open && (
        <AppDialog title="四人将棋の棋譜解析" theme="four-shogi" onClose={() => setOpen(false)}>
          <div className="mb-3 flex gap-2">
            <AppButton
              size="compact"
              appearance="quiet"
              isDisabled={index === 0}
              onPress={() => select(index - 1)}
            >
              前の局面
            </AppButton>
            <AppButton
              size="compact"
              appearance="quiet"
              isDisabled={index === frames.length - 1}
              onPress={() => select(index + 1)}
            >
              次の局面
            </AppButton>
          </div>
          <AnalysisPanel
            key={`${match.id}:${index}:${account.user.profileId}:${account.generation}`}
            match={match}
            frames={frames}
            index={index}
          />
        </AppDialog>
      )}
    </>
  );
}
