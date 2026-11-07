import { notificationRequest, NotificationRequestError } from "./notificationRequest";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  notificationListSchema,
  notificationUnreadSchema,
  type Notification,
} from "@tetraboard/protocol";
import { useAccount } from "../account/useAccount";
import { NotificationContext } from "./NotificationContext";
import { NotificationCache } from "./notificationCache";
import { isAnonymousRead, loadAnonymousReads, saveAnonymousReads } from "./anonymousReads";

type NotificationStatus = {
  owner: string;
  identity: string | null;
  hasUnread: boolean;
  upperBound: number;
  error: string | null;
  storageError: boolean;
};
function statusForOwner(status: NotificationStatus, owner: string): NotificationStatus {
  return status.owner === owner
    ? status
    : { owner, identity: null, hasUnread: false, upperBound: 0, error: null, storageError: false };
}

class NotificationRequestScope {
  readonly identity: string | null;
  controller = new AbortController();
  private users = 0;
  private requests = new Map<string, Promise<unknown>>();
  constructor(identity: string | null) {
    this.identity = identity;
  }
  share(path: string, load: () => Promise<unknown>) {
    const active = this.requests.get(path);
    if (active) return active;
    const pending = load().finally(() => {
      if (this.requests.get(path) === pending) this.requests.delete(path);
    });
    this.requests.set(path, pending);
    return pending;
  }
  forget(path: string) {
    this.requests.delete(path);
  }
  attach() {
    this.users++;
    return () => {
      this.users--;
      queueMicrotask(() => {
        if (!this.users) this.controller.abort();
      });
    };
  }
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const account = useAccount();
  const owner = account.user
    ? `account:${account.user.profileId ?? account.user.username ?? `incomplete:${account.generation ?? 0}`}`
    : "anonymous";
  const identity = account.loading || account.error ? null : `${owner}:${account.generation ?? 0}`;
  const current = useRef(identity);
  useLayoutEffect(() => {
    current.current = identity;
  }, [identity]);
  const [headers, setHeaders] = useState(0);
  const [status, setStatus] = useState<NotificationStatus>({
    owner,
    identity,
    hasUnread: false,
    upperBound: 0,
    error: null as string | null,
    storageError: false,
  });
  // 認証の再確認中は非表示にし、確認後も同じ本人なら先読み結果を使えます。
  const cache = useMemo(() => new NotificationCache(owner), [owner]);
  const cachedPage = useSyncExternalStore(cache.subscribe, cache.getSnapshot, cache.getSnapshot);
  const scope = useMemo(() => new NotificationRequestScope(identity), [identity]);
  const anonymous = useRef<ReturnType<typeof loadAnonymousReads>["state"]>(null);
  const refreshVersion = useRef(0);
  const registerHeader = useCallback(() => {
    setHeaders((n) => n + 1);
    return () => setHeaders((n) => n - 1);
  }, []);
  const valid = useCallback(
    () => Boolean(identity && current.current === identity && !scope.controller.signal.aborted),
    [identity, scope],
  );
  const request = useCallback(
    async (path: string, body?: unknown) => {
      if (!valid()) throw new Error("本人を確認しています。");
      const load = () => notificationRequest(path, scope.controller.signal, body);
      const value = await (body === undefined ? scope.share(path, load) : load());
      if (!valid()) throw new Error("本人が切り替わりました。");
      return value;
    },
    [valid, scope],
  );
  const storeAnonymous = useCallback(
    (state: NonNullable<typeof anonymous.current>) => {
      if (!valid()) return;
      anonymous.current = state;
      const saved = saveAnonymousReads(state);
      setStatus((old) => ({ ...statusForOwner(old, owner), identity, storageError: !saved }));
    },
    [owner, identity, valid],
  );
  const list = useCallback(
    async (cursor?: string) => {
      const revision = cache.getRevision();
      let page = notificationListSchema.parse(
        await request(`notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
      );
      if (!valid() || revision !== cache.getRevision())
        throw new Error("お知らせが更新されました。再試行してください。");
      if (owner === "anonymous") {
        anonymous.current = loadAnonymousReads().state;
        if (!anonymous.current) storeAnonymous({ through: page.upperBound, ids: [] });
        page = {
          ...page,
          notifications: page.notifications.map((n) => ({
            ...n,
            read: isAnonymousRead(anonymous.current!, n.id, n.legacy),
          })),
        };
      }
      return cursor === undefined ? cache.store(page) : cache.apply(page);
    },
    [owner, request, storeAnonymous, valid, cache],
  );
  const refresh = useCallback(async () => {
    if (!valid()) return;
    const version = ++refreshVersion.current;
    const latest = () => valid() && version === refreshVersion.current;
    const prefetch = () => {
      void list().catch(() => {
        if (latest())
          setStatus((old) => ({
            ...statusForOwner(old, owner),
            identity,
            error: "お知らせの一覧を更新できませんでした。",
          }));
      });
    };
    try {
      if (owner === "anonymous") {
        const first = await list();
        const state = anonymous.current!;
        let page = first;
        let hasUnread = false;
        for (;;) {
          if (page.notifications.some((n) => !isAnonymousRead(state, n.id, n.legacy))) {
            hasUnread = true;
            break;
          }
          if (
            !page.nextCursor ||
            !page.notifications.length ||
            page.notifications.at(-1)!.id <= state.through
          )
            break;
          page = notificationListSchema.parse(
            await request(
              `notifications?after=${state.through}&cursor=${encodeURIComponent(page.nextCursor)}`,
            ),
          );
        }
        if (latest())
          setStatus({
            owner,
            identity,
            hasUnread,
            upperBound: first.upperBound,
            error: null,
            storageError: loadAnonymousReads().storageError,
          });
      } else {
        // 初回は未読確認と一覧を並行取得し、ロビーやベル操作を待たせません。
        const unreadRequest = request("account/notifications/unread");
        if (!cache.getSnapshot()) prefetch();
        const result = notificationUnreadSchema.parse(await unreadRequest);
        if (!latest()) return;
        const page = cache.getSnapshot();
        setStatus({
          owner,
          identity,
          hasUnread:
            result.hasUnread ||
            Boolean(page?.notifications.some((n) => n.id > result.upperBound && !n.read)),
          upperBound: result.upperBound,
          error: null,
          storageError: false,
        });
        if (page && page.upperBound !== result.upperBound) prefetch();
      }
    } catch {
      if (latest())
        setStatus((old) => ({
          ...statusForOwner(old, owner),
          identity,
          error: "お知らせを更新できませんでした。",
        }));
    }
  }, [owner, identity, request, list, valid, cache]);
  useEffect(() => {
    if (!headers || !identity) return;
    let busy = false;
    const wake = () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      void refresh().finally(() => {
        busy = false;
      });
    };
    wake();
    const timer = setInterval(wake, 30_000);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("storage", wake);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("storage", wake);
    };
  }, [headers, identity, refresh]);
  useEffect(() => scope.attach(), [scope]);
  const read = useCallback(
    async (n: Notification) => {
      if (!valid()) throw new Error("本人を確認しています。");
      if (owner === "anonymous") {
        if (!anonymous.current) await list();
        const state = anonymous.current!;
        if (!isAnonymousRead(state, n.id, n.legacy))
          storeAnonymous({ ...state, ids: [...state.ids, n.id] });
      } else {
        try {
          await request("account/notifications/read", { id: n.id });
        } catch (error) {
          if (valid() && error instanceof NotificationRequestError && error.status === 404) {
            cache.remove(n.id);
            scope.forget("notifications");
          }
          throw error;
        }
      }
      if (!valid()) throw new Error("本人が切り替わりました。");
      cache.markRead(n.id);
      refreshVersion.current++;
      scope.forget("account/notifications/unread");
      void refresh();
    },
    [owner, list, refresh, request, storeAnonymous, valid, cache, scope],
  );
  const readAll = useCallback(
    async (through: number) => {
      if (!valid()) throw new Error("本人を確認しています。");
      if (owner === "anonymous")
        storeAnonymous({
          through: Math.max(through, anonymous.current?.through ?? 0),
          ids: (anonymous.current?.ids ?? []).filter((id) => id > through),
        });
      else await request("account/notifications/read-all", { through });
      if (!valid()) throw new Error("本人が切り替わりました。");
      cache.markThrough(through);
      refreshVersion.current++;
      scope.forget("account/notifications/unread");
      setStatus((old) => {
        const status = statusForOwner(old, owner);
        return { ...status, identity, hasUnread: status.upperBound > through && status.hasUnread };
      });
      void refresh();
    },
    [owner, identity, refresh, request, storeAnonymous, valid, cache, scope],
  );
  const readAnnouncement = useCallback(
    async (id: string) => {
      const cached = cache
        .getSnapshot()
        ?.notifications.find((n) => n.kind === "announcement" && n.announcement.id === id);
      if (cached) {
        await read(cached);
        return;
      }
      const page = notificationListSchema.parse(
        await request(`notifications?announcementId=${encodeURIComponent(id)}`),
      );
      if (page.notifications[0]) await read(page.notifications[0]);
    },
    [request, read, cache],
  );
  const value = useMemo(
    () => ({
      identity,
      hasUnread: status.identity === identity && status.hasUnread,
      error: status.identity === identity ? status.error : null,
      storageError: status.identity === identity && status.storageError,
      cachedPage: identity ? cachedPage : null,
      registerHeader,
      refresh,
      list,
      read,
      readAll,
      readAnnouncement,
    }),
    [identity, status, cachedPage, registerHeader, refresh, list, read, readAll, readAnnouncement],
  );
  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}
