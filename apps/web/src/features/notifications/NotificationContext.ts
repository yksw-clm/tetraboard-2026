import { createContext, useContext } from "react";
import type { Notification } from "@tetraboard/protocol";
import type { DisplayNotificationList } from "./notificationResponses";
export type NotificationCenter = {
  identity: string | null;
  hasUnread: boolean;
  error: string | null;
  storageError: boolean;
  cachedPage: DisplayNotificationList | null;
  registerHeader: () => () => void;
  refresh: () => Promise<void>;
  list: (cursor?: string) => Promise<DisplayNotificationList>;
  read: (notification: Notification) => Promise<void>;
  readAll: (through: number) => Promise<void>;
  readAnnouncement: (id: string) => Promise<void>;
};
export const NotificationContext = createContext<NotificationCenter | null>(null);
export const useNotificationCenter = () => useContext(NotificationContext);
