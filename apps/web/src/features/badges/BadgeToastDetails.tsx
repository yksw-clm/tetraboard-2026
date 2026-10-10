import { useEffect } from "react";
import { badgeDefinitions, getBadgeIds, type BadgeNotification } from "@tetraboard/protocol";
import { gameCatalog } from "@tetraboard/protocol/games";
import { BadgeImage } from "./BadgeImage";

export function BadgeToastDetails({
  notification,
  onShown,
}: {
  notification: BadgeNotification;
  onShown: () => void;
}) {
  useEffect(() => {
    const show = () => {
      if (document.visibilityState !== "hidden") onShown();
    };
    show();
    document.addEventListener("visibilitychange", show);
    return () => document.removeEventListener("visibilitychange", show);
  }, [onShown]);
  const ordered = getBadgeIds(notification.game).flatMap((id) =>
    notification.badges.filter((b) => b.id === id),
  );
  return (
    <span className="flex min-w-0 flex-col items-center gap-2">
      <span>{gameCatalog[notification.game].name}</span>
      <span className="flex w-full flex-wrap justify-center gap-2">
        {ordered.map((badge) => (
          <span
            key={badge.id}
            className="flex w-14 shrink-0 flex-col items-center text-center text-xs"
          >
            <BadgeImage game={notification.game} {...badge} size={56} />
            <span>{badgeDefinitions[badge.id].name}</span>
            <span>
              星{badge.tier}
              <span className="sr-only">
                ・累計{badge.value}
                {badgeDefinitions[badge.id].unit}
              </span>
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}
