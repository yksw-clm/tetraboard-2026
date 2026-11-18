import type { Notification } from "@tetraboard/protocol";
import { canMarkAllNotificationsRead, notificationPageSize } from "../domain/notifications";

export type NotificationQuery = {
  before?: number;
  after?: number;
  id?: number;
  announcementId?: string;
};

export interface NotificationStore {
  initializeReadState(accountId: string): Promise<void>;
  list(accountId: string, query: NotificationQuery): Promise<Notification[]>;
  upperBound(accountId: string): Promise<number>;
  hasUnread(accountId: string): Promise<boolean>;
  insertRead(accountId: string, id: number): Promise<boolean>;
  issuedThrough(): Promise<number>;
  advanceReadAll(accountId: string, through: number): Promise<void>;
}

export function prepareNotifications(
  store: Pick<NotificationStore, "initializeReadState">,
  accountId: string,
): Promise<void> {
  return store.initializeReadState(accountId);
}

export async function listNotifications(
  store: Pick<NotificationStore, "upperBound" | "list">,
  accountId: string,
  query: NotificationQuery,
) {
  const upperBound = await store.upperBound(accountId);
  const rows = await store.list(accountId, query);
  const notifications = rows.slice(0, notificationPageSize);
  return {
    notifications,
    upperBound: Math.max(upperBound, notifications[0]?.id ?? 0),
    nextCursor: rows.length > notificationPageSize ? String(notifications.at(-1)!.id) : null,
  };
}

export async function readNotification(
  store: Pick<NotificationStore, "list">,
  accountId: string,
  id: number,
) {
  return (await store.list(accountId, { id }))[0] ?? null;
}

export async function readNotificationStatus(
  store: Pick<NotificationStore, "hasUnread" | "upperBound">,
  accountId: string,
) {
  return {
    hasUnread: await store.hasUnread(accountId),
    upperBound: await store.upperBound(accountId),
  };
}

export async function markNotificationRead(
  store: Pick<NotificationStore, "insertRead" | "list">,
  accountId: string,
  id: number,
): Promise<boolean> {
  if (await store.insertRead(accountId, id)) return true;
  // 既読の再送は成功扱いにし、閲覧できない通知は見つからないものとして扱います。
  return (await readNotification(store, accountId, id)) !== null;
}

export async function markAllNotificationsRead(
  store: Pick<NotificationStore, "initializeReadState" | "issuedThrough" | "advanceReadAll">,
  accountId: string,
  through: number,
): Promise<boolean> {
  await prepareNotifications(store, accountId);
  // 将来の通知まで既読にする指定を拒否します。
  if (!canMarkAllNotificationsRead(through, await store.issuedThrough())) return false;
  await store.advanceReadAll(accountId, through);
  return true;
}
