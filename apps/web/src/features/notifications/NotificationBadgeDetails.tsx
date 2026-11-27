import { badgeDefinitions, getBadgeIds, type Notification } from "@tetraboard/protocol";
import { BadgeImage } from "../badges/BadgeImage";

export function NotificationBadgeDetails({
  award,
}: {
  award: Extract<Notification, { kind: "badge" }>["badge"];
}) {
  return (
    <div className="flex flex-wrap gap-4">
      {getBadgeIds(award.game)
        .flatMap((id) => award.badges.filter((badge) => badge.id === id))
        .map((badge) => (
          <div key={badge.id} className="flex flex-col items-center gap-1 text-sm">
            <BadgeImage game={award.game} {...badge} size={56} />
            <span>
              {badgeDefinitions[badge.id].name}・星{badge.tier}
            </span>
            <span>
              累計{badge.value}
              {badgeDefinitions[badge.id].unit}
            </span>
          </div>
        ))}
    </div>
  );
}
