import type { BadgeNotification } from "@tetraboard/protocol";

export function badgeToastTitle(notification: BadgeNotification) {
  if (notification.badges.length > 1)
    return `バッジを${notification.badges.length}個獲得・更新しました！`;
  const badge = notification.badges[0]!;
  return badge.previousTier === 0
    ? "バッジを獲得しました！"
    : `バッジが星${badge.tier}になりました！`;
}
