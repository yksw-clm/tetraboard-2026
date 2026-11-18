import type { BadgeId } from "@tetraboard/protocol";
import type { BadgeGame } from "../domain/badges";

export type BadgeNotificationOperation = "shown" | "renew" | "release";
type NotificationGroup = { id: string; game: BadgeGame };
type NotificationInput = { accountId: string; token: string };
export type NotificationTarget = NotificationInput & { id: string };
type BadgeRow = { id: string; tier: number; previousTier: number; value: number };

export interface BadgeNotificationStore {
  claim(input: NotificationInput, now: number, until: number): Promise<NotificationGroup | null>;
  readAwards(accountId: string, matchId: string): Promise<BadgeRow[]>;
  update(
    operation: BadgeNotificationOperation,
    input: NotificationTarget,
    now: number,
    value: number,
  ): Promise<boolean>;
  wasShown(input: NotificationTarget): Promise<boolean>;
}

const leaseMs = 15_000;

export async function claimBadgeNotification(
  store: BadgeNotificationStore,
  input: NotificationInput,
  now: number,
  badgeIds: (game: BadgeGame) => readonly BadgeId[],
) {
  const claimed = await store.claim(input, now, now + leaseMs);
  if (!claimed) return null;
  const rows = await store.readAwards(input.accountId, claimed.id);
  const badges = badgeIds(claimed.game).flatMap((id) => rows.filter((row) => row.id === id));
  return { ...claimed, badges };
}

export async function updateBadgeNotification(
  store: BadgeNotificationStore,
  operation: BadgeNotificationOperation,
  input: NotificationTarget,
  now: number,
): Promise<boolean> {
  const value = operation === "renew" ? now + leaseMs : operation === "release" ? 0 : now;
  const updated = await store.update(operation, input, now, value);
  if (updated || operation === "release") return true;
  // 同じ token の表示済み記録は、応答を失った再送でも成功扱いにします。
  return operation === "shown" && (await store.wasShown(input));
}
