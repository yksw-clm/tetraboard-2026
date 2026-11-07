import type { NotificationList } from "@tetraboard/protocol";

/** 本人ごとの最新20件と、このタブで確定した既読だけをメモリに保持します。 */
export class NotificationCache {
  readonly owner: string;
  private page: NotificationList | null = null;
  private reads = new Set<number>();
  private readThrough = 0;
  private revision = 0;
  getRevision = () => this.revision;
  private listeners = new Set<() => void>();
  constructor(owner: string) {
    this.owner = owner;
  }
  getSnapshot = () => this.page;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(page: NotificationList) {
    this.page = page;
    for (const listener of this.listeners) listener();
  }
  apply(page: NotificationList): NotificationList {
    // 既読は単調に進め、取得開始後に保存した既読を古い応答で巻き戻しません。
    for (const entry of page.notifications) if (entry.read) this.reads.add(entry.id);
    return {
      ...page,
      notifications: page.notifications.map((entry) => ({
        ...entry,
        read: entry.read || entry.id <= this.readThrough || this.reads.has(entry.id),
      })),
    };
  }
  store(page: NotificationList) {
    const result = this.apply(page);
    this.publish(result);
    return result;
  }
  markRead(id: number) {
    this.reads.add(id);
    if (this.page) this.publish(this.apply(this.page));
  }
  markThrough(through: number) {
    this.readThrough = Math.max(this.readThrough, through);
    if (this.page) this.publish(this.apply(this.page));
  }
  remove(id: number) {
    this.revision++;
    if (this.page)
      this.publish({
        ...this.page,
        notifications: this.page.notifications.filter((n) => n.id !== id),
      });
  }
}
