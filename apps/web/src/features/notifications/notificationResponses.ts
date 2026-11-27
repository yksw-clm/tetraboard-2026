import {
  notificationListSchema,
  type Notification,
  type NotificationList,
} from "@tetraboard/protocol";
import { boardPostExcerpt, boardPostPath } from "@tetraboard/protocol/board-presentation";
import { gameCatalog } from "@tetraboard/protocol/games";
import { createElement, type ReactElement } from "react";
import { badgeToastTitle } from "../badges/badgeNotificationPresentation";
import { NotificationBadgeDetails } from "./NotificationBadgeDetails";

type Presentation = {
  label: string;
  title: string;
  path: string;
  linkLabel: string;
  subtitle?: string;
  body?: string;
  badgeDetails?: ReactElement;
};
export type DisplayNotification = Notification & { presentation: Presentation };
export type DisplayNotificationList = Omit<NotificationList, "notifications"> & {
  notifications: DisplayNotification[];
};

function present(n: Notification): Presentation {
  switch (n.kind) {
    case "announcement":
      return {
        label: "運営からのお知らせ",
        title: n.announcement.title,
        path: `/updates/${n.announcement.id}`,
        linkLabel: "元の記事へ",
        body: n.announcement.body,
      };
    case "tournament": {
      const { name, id, tied, rank } = n.tournament;
      const placement = `${tied ? "同率" : ""}${rank === 1 ? "優勝" : "準優勝"}`;
      return {
        label: "大会結果",
        title: `${name}で${placement}しました！`,
        path: `/tournaments/${id}`,
        linkLabel: "大会結果へ",
        body: `${name}の結果が確定しました。${placement}おめでとうございます！`,
      };
    }
    case "badge":
      return {
        label: "バッジ",
        title: badgeToastTitle(n.badge),
        path: "/account",
        linkLabel: "マイページでバッジを見る",
        subtitle: gameCatalog[n.badge.game].name,
        badgeDetails: createElement(NotificationBadgeDetails, { award: n.badge }),
      };
    case "reply": {
      const { authorName, text, postNumber, gameId } = n.reply;
      return {
        label: "返信",
        title: `${authorName}さんから返信: ${boardPostExcerpt(text, 30)}`,
        path: boardPostPath(postNumber),
        linkLabel: "投稿を見る",
        subtitle: `${gameCatalog[gameId].name}の掲示板`,
        body: text,
      };
    }
  }
}

export function parseNotificationList(value: unknown): DisplayNotificationList {
  const page = notificationListSchema.parse(value);
  return {
    ...page,
    notifications: page.notifications.map((n) => ({ ...n, presentation: present(n) })),
  };
}
