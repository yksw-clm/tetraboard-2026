import type { ReversiLastRound } from "@tetraboard/protocol";
import { PlayerAvatar } from "./PlayerAvatar";
import { Stone } from "./Stone";
export function ReversiResult({ lastRound }: { lastRound: ReversiLastRound }) {
  const { game, players } = lastRound;
  const winner = game.result.winner;
  const sorted = [...players].sort(
    (a, b) => Number(b.color === winner) - Number(a.color === winner),
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        {game.result.reason === "board_full"
          ? "盤が埋まりました。"
          : game.result.reason === "all_passed"
            ? "双方が石を置けなくなりました。"
            : "投了・退室・時間切れ・通信切れにより終局しました。"}
      </p>
      {sorted.map((p) => (
        <div key={p.id} className="flex items-center gap-2">
          <strong className="w-16 shrink-0 text-sm">
            {winner === null ? "引き分け" : winner === p.color ? "勝利" : "敗北"}
          </strong>
          <Stone color={p.color} className="size-5 shrink-0" />
          <span className="w-8 text-sm tabular-nums">{game.result.stoneCounts[p.color]}</span>
          <PlayerAvatar appearance={p.appearance ?? null} className="size-7" />
          <span className="text-sm font-semibold wrap-anywhere">{p.name}</span>
        </div>
      ))}
    </div>
  );
}
