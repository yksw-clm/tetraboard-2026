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
    <section aria-label="獲得済みバッジ">
      <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
        {ordered.map(({ id, tier, value }) => {
          const definition = badgeDefinitions[id];
          const description = `${definition.name}・星${tier}・${value}${definition.unit}`;
          return (
            <li key={id} className="min-w-0 max-w-full">
              <span role="img" aria-label={description} className="inline-flex max-w-full">
                <BadgeImage game={game} id={id} tier={tier} value={value} size={56} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
