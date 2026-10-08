import {
  badgeDefinitions,
  getBadgeProgress,
  type AccountStats,
  type GameId,
} from "@tetraboard/protocol";
import { BadgeImage } from "./BadgeImage";

export function AccountBadges({ game, stats }: { game: GameId; stats: AccountStats }) {
  return (
    <section aria-labelledby="account-badges-title" className="flex min-w-0 flex-col gap-2">
      <h2 id="account-badges-title" className="m-0 text-lg font-bold">
        バッジ
      </h2>
      <p className="m-0 text-xs text-muted">シングルス・対人戦のみ集計</p>
      <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0">
        {getBadgeProgress(game, stats).map(({ id, tier, value, nextThreshold }) => {
          const definition = badgeDefinitions[id];
          return (
            <li
              key={id}
              className="flex min-w-0 flex-col items-center gap-2 rounded-panel bg-surface-muted p-2 text-center [@media(min-width:651px)]:flex-row [@media(min-width:651px)]:text-left"
            >
              <BadgeImage game={game} id={id} tier={tier} value={value} size={72} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex flex-wrap items-baseline justify-center gap-x-2 [@media(min-width:651px)]:justify-start">
                  <h3 className="m-0 text-sm font-bold">{definition.name}</h3>
                  <span className="text-xs text-muted">{tier === 0 ? "未獲得" : `星${tier}`}</span>
                </div>
                <p className="m-0 text-xs tabular-nums wrap-anywhere">
                  {value}
                  {definition.unit}
                  {nextThreshold !== null && ` / ${nextThreshold}${definition.unit}`}
                </p>
                <p className="m-0 text-[11px] leading-snug text-muted">{definition.condition}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
