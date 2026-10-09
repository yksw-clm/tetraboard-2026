import type { ShogiLastRound } from "@tetraboard/protocol";
import { impassePoints } from "@tetraboard/shogi";
import { PlayerAvatar } from "./PlayerAvatar";
const reasons = {
  resigned: "投了",
  left: "退室",
  timeout: "時間切れ",
  disconnected: "通信切れ",
  checkmate: "詰み",
  no_legal_actions: "合法手なし",
  perpetual_check: "連続王手の千日手",
  impasse: "持将棋",
  invalid_declaration: "入玉宣言の条件不成立",
  repetition: "千日手",
  declaration: "入玉宣言",
  move_limit: "500手の上限",
};
export function ShogiResult({ lastRound }: { lastRound: ShogiLastRound }) {
  const { game } = lastRound;
  return (
    <div className="flex flex-col gap-3">
      <p className="font-bold text-brand">{reasons[game.result.reason]}</p>
      {[...lastRound.players]
        .sort(
          (a, b) => Number(b.side === game.result.winner) - Number(a.side === game.result.winner),
        )
        .map((p) => (
          <div key={p.id} className="flex items-center gap-3 rounded-lg bg-surface-muted p-3">
            <PlayerAvatar
              appearance={p.appearance ?? { kind: "human", avatarUrl: null }}
              className="size-8"
            />
            <span className="flex-1 font-bold">{p.name}</span>
            <span>
              {game.result.winner === null
                ? "引き分け"
                : p.side === game.result.winner
                  ? "勝利"
                  : "敗北"}
            </span>
            {game.result.reason === "impasse" && (
              <span className="text-xs">{impassePoints(game, p.side)}点</span>
            )}
          </div>
        ))}
    </div>
  );
}
