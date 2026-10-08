import { badgeDefinitions, getBadgeIds, type EarnedBadge, type GameId } from "@tetraboard/protocol";
import { BadgeImage } from "./BadgeImage";

export function PlayerBadges({
  game,
  badges,
}: {
  game: GameId;
  badges: EarnedBadge[] | undefined;
}) {
  const ordered = getBadgeIds(game).flatMap((id) => badges?.find((badge) => badge.id === id) ?? []);
  if (!ordered.length) return null;
  return (
    <section aria-label="獲得済みバッジ" className="flex flex-col gap-1">
      <p className="m-0 text-xs font-semibold">バッジ</p>
      <ul className="m-0 grid list-none grid-cols-4 gap-1 p-0">
        {ordered.map(({ id, tier, value }) => {
          const definition = badgeDefinitions[id];
          const description = `${definition.name}・星${tier}・${value}${definition.unit}。${definition.condition}。星${tier}の条件：${definition.thresholds[tier - 1]}${definition.unit}`;
          return (
            <li key={id} className="flex min-w-0 flex-col items-center" title={description}>
              <span role="img" aria-label={description} className="inline-flex max-w-full">
                <BadgeImage game={game} id={id} tier={tier} value={value} size={56} />
              </span>
              <span className="text-center text-[10px]">{definition.name}</span>
              <span className="text-center text-[10px] tabular-nums wrap-anywhere">
                星{tier}・{value}
                {definition.unit}
              </span>
            </li>
          );
        })}
      </ul>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">獲得条件</summary>
        <ul className="mt-1 mb-0 space-y-1 pl-4">
          {ordered.map(({ id, tier }) => (
            <li key={id}>
              {badgeDefinitions[id].name}・星{tier}：{badgeDefinitions[id].condition}。
              {badgeDefinitions[id].thresholds[tier - 1]}
              {badgeDefinitions[id].unit}達成。
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
