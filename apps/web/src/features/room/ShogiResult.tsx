import {
  shogiPlacementGames,
  type ShogiLastRound,
  type ShogiRatingResult,
} from "@tetraboard/protocol";
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
const ratingChangeFormat = new Intl.NumberFormat("ja", { signDisplay: "exceptZero" });

type AppliedRating = Extract<ShogiRatingResult, { status: "rated" | "placement" }>;

function ratingLabel(rating: AppliedRating | AppliedRating["opponent"]) {
  if (!rating) return;
  if (rating.status === "placement")
    return "games" in rating ? `認定戦 ${rating.games} / ${shogiPlacementGames}局` : "認定中";
  const current = Math.round(rating.rating);
  if (rating.status === "cpu") return String(current);
  const change = current - Math.round(rating.previousRating);
  return `${current} (${ratingChangeFormat.format(change)})`;
}

export function ShogiResult({
  lastRound,
  selfId,
  ratingResult,
}: {
  lastRound: ShogiLastRound;
  selfId?: string;
  ratingResult?: ShogiRatingResult | null;
}) {
  const { game } = lastRound;
  const rated =
    ratingResult?.status === "rated" || ratingResult?.status === "placement"
      ? ratingResult
      : undefined;
  return (
    <div className="flex flex-col gap-3">
      <p className="font-bold text-brand">{reasons[game.result.reason]}</p>
      {[...lastRound.players]
        .sort(
          (a, b) => Number(b.side === game.result.winner) - Number(a.side === game.result.winner),
        )
        .map((p) => {
          const rating = ratingLabel(p.id === selfId ? rated : rated?.opponent);
          return (
            <div key={p.id} className="flex items-center gap-3 rounded-lg bg-surface-muted p-3">
              <PlayerAvatar
                appearance={p.appearance ?? { kind: "human", avatarUrl: null }}
                className="size-8"
              />
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="min-w-0 font-bold [overflow-wrap:anywhere]">{p.name}</span>
                {rating && (
                  <span className="text-sm whitespace-nowrap text-muted tabular-nums">
                    {rating}
                  </span>
                )}
              </div>
              <span className="shrink-0">
                {game.result.winner === null
                  ? "引き分け"
                  : p.side === game.result.winner
                    ? "勝利"
                    : "敗北"}
              </span>
              {game.result.reason === "impasse" && (
                <span className="shrink-0 text-xs">{impassePoints(game, p.side)}点</span>
              )}
            </div>
          );
        })}
    </div>
  );
}
