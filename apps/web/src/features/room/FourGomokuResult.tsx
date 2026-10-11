import type { FourGomokuLastRound } from "@tetraboard/protocol";
import { teamForColor } from "@tetraboard/four-gomoku";
import { formatClock } from "./roomCommonPresentation";
import { standingReasons } from "./fourGomokuPresentation";
import { PlayerAvatar } from "./PlayerAvatar";
import { Stone } from "./Stone";
export function FourGomokuResult({ lastRound }: { lastRound: FourGomokuLastRound }) {
  const { game, players, settings } = lastRound;
  const result = game.result;
  const lastAction = lastRound.replay.steps.at(-1)?.action;
  const rank = (color: (typeof players)[number]["color"]) =>
    game.standings.find((s) => s.color === color);
  const sorted = [...players].sort((a, b) =>
    result.mode === "singles"
      ? (rank(a.color)?.rank ?? 4) - (rank(b.color)?.rank ?? 4)
      : Number(teamForColor(b.color) === result.winner) -
        Number(teamForColor(a.color) === result.winner),
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        {settings.mode === "singles" ? "シングルス" : "ダブルス"}・持ち時間：
        {formatClock(settings.timeControl.mainTimeMs)}・秒読み：
        {formatClock(settings.timeControl.byoyomiMs)}
      </p>
      {result.mode === "doubles" && (
        <p className="text-sm text-muted">
          {result.winner === null
            ? "満盤で引き分けです。"
            : `${result.winner === "black-red" ? "黒・赤" : "白・青"}チームの勝利です。`}
        </p>
      )}
      {result.mode === "doubles" && lastAction?.type === "eliminate" && (
        <p className="text-xs text-muted">
          {{ black: "黒", white: "白", red: "赤", blue: "青" }[lastAction.color]}：
          {standingReasons[lastAction.reason]}
        </p>
      )}
      {sorted.map((p) => {
        const standing = rank(p.color);
        return (
          <div key={p.id} className="flex items-center gap-2">
            <strong className="w-16 shrink-0 text-sm">
              {result.mode === "singles"
                ? `${standing?.rank}位`
                : result.winner === null
                  ? "引き分け"
                  : teamForColor(p.color) === result.winner
                    ? "勝利"
                    : "敗北"}
            </strong>
            <Stone color={p.color} className="size-5 shrink-0" />
            <PlayerAvatar appearance={p.appearance ?? null} className="size-7" />
            <span className="text-sm font-semibold wrap-anywhere">{p.name}</span>
            {standing && (
              <span className="text-xs text-muted">{standingReasons[standing.reason]}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
