import {
  badgeDefinitions,
  getBadgeProgress,
  type AccountStats,
  type GameId,
} from "@tetraboard/protocol";
import { BadgeImage } from "./BadgeImage";

export function AccountBadges({ game, stats }: { game: GameId; stats: AccountStats }) {
  return (
    <section aria-labelledby="account-badges-title" className="flex min-w-0 flex-col gap-3">
      <h2 id="account-badges-title" className="m-0 text-lg font-bold">
        バッジ
      </h2>
      <p className="m-0 text-xs text-muted">シングルス・対人戦のみ集計</p>
      <ul className="m-0 grid list-none grid-cols-2 gap-4 p-0">
        {getBadgeProgress(game, stats).map(({ id, tier, value, nextThreshold }) => {
          const definition = badgeDefinitions[id];
          return (
            <li
              key={id}
              className="flex min-w-0 flex-col items-center gap-1 rounded-panel bg-surface-muted p-3 text-center"
            >
              <BadgeImage game={game} id={id} tier={tier} value={value} size={104} />
              <h3 className="m-0 text-sm font-bold">{definition.name}</h3>
              <p className="m-0 text-xs font-semibold">{tier === 0 ? "未獲得" : `星${tier}`}</p>
              <p className="m-0 text-sm tabular-nums wrap-anywhere">
                {value}
                {definition.unit}
                {nextThreshold !== null && ` / ${nextThreshold}${definition.unit}`}
              </p>
              <p className="m-0 text-xs text-muted">
                {nextThreshold === null
                  ? "最高ランク達成"
                  : `次の星まであと${nextThreshold - value}${definition.unit}`}
              </p>
              <p className="m-0 text-xs text-muted">{definition.condition}</p>
              <p className="m-0 text-xs text-muted">
                星1 / 星2 / 星3：
                {definition.thresholds
                  .map((threshold) => `${threshold}${definition.unit}`)
                  .join(" / ")}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
