import type { AnnouncementRecord } from "@tetraboard/protocol";

export type AnnouncementScope = "public" | "admin";
export type AnnouncementCursor = { date: string; at: number; id: string };

export function announcementDetail({ id, title, body, date, kind }: AnnouncementRecord) {
  return { id, title, body, date, kind };
}
