import { formatClock } from "./roomCommonPresentation";
import type { GomokuLastRound } from "@tetraboard/protocol";
import { PlayerAvatar } from "./PlayerAvatar";
import { Stone } from "./Stone";
export function GomokuResult({ lastRound }: { lastRound: GomokuLastRound }) {
  const { game, players } = lastRound;
  const winner = game.result.winner;
  const lastAction = lastRound.replay.steps.at(-1)?.action;
  const externalReason =
    lastAction?.type === "eliminate"
      ? `${lastAction.color === "black" ? "黒" : "白"} ${{ resigned: "投了", left: "退室", timeout: "時間切れ", disconnected: "通信切れ" }[lastAction.reason]}`
      : "外部敗北";
  const sorted = [...players].sort(
    (a, b) => Number(b.color === winner) - Number(a.color === winner),
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        禁手ルール：{lastRound.settings.forbiddenRules ? "ON" : "OFF"}・持ち時間：
        {formatClock(lastRound.settings.timeControl.mainTimeMs)}・秒読み：
        {formatClock(lastRound.settings.timeControl.byoyomiMs)}
      </p>
      <p className="text-sm text-muted">
        {
          {
            five: "五連が成立しました。",
            board_full: "満盤で引き分けです。",
            no_legal_moves: "黒の合法手なし：白の勝ちです。",
            last_player: externalReason,
          }[game.result.reason]
        }
      </p>
      {sorted.map((p) => (
        <div key={p.id} className="flex items-center gap-2">
          <strong className="w-16 shrink-0 text-sm">
            {winner === null ? "引き分け" : winner === p.color ? "勝利" : "敗北"}
          </strong>
          <Stone color={p.color} className="size-5 shrink-0" />
          <span className="min-w-10 text-sm tabular-nums">
            {game.result.stoneCounts[p.color]}個
          </span>
          <PlayerAvatar appearance={p.appearance ?? null} className="size-7" />
          <span className="text-sm font-semibold wrap-anywhere">{p.name}</span>
        </div>
      ))}
    </div>
  );
}
