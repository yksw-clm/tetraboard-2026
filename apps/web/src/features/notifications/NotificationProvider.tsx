import { notificationRequest } from "./notificationRequest";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  notificationListSchema,
  notificationSchema,
  notificationUnreadSchema,
  type Notification,
} from "@tetraboard/protocol";
import { useAccount } from "../account/useAccount";
import { NotificationContext } from "./NotificationContext";
import { isAnonymousRead, loadAnonymousReads, saveAnonymousReads } from "./anonymousReads";

class NotificationRequestScope {
  readonly identity: string | null;
  constructor(identity: string | null) {
    this.identity = identity;
  }
  controller = new AbortController();
  private users = 0;
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
  const identity =
    account.loading || account.error
      ? null
      : account.user
        ? `account:${account.user.profileId ?? account.user.username ?? "incomplete"}:${account.generation ?? 0}`
        : "anonymous";
  const current = useRef(identity);
  useLayoutEffect(() => {
    current.current = identity;
  }, [identity]);
  const [headers, setHeaders] = useState(0);
  const [status, setStatus] = useState({
    identity,
    hasUnread: false,
    error: null as string | null,
    storageError: false,
  });
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
      const value = await notificationRequest(path, scope.controller.signal, body);
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
      if (valid()) setStatus((old) => ({ ...old, identity, storageError: !saved }));
    },
    [identity, valid],
  );
  const list = useCallback(
    async (cursor?: string) => {
      const page = notificationListSchema.parse(
        await request(`notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
      );
      if (identity === "anonymous") {
        anonymous.current ??= loadAnonymousReads().state;
        if (!anonymous.current) storeAnonymous({ through: page.upperBound, ids: [] });
        return {
          ...page,
          notifications: page.notifications.map((n) => ({
            ...n,
            read: isAnonymousRead(anonymous.current!, n.id, n.legacy),
          })),
        };
      }
      return page;
    },
    [identity, request, storeAnonymous],
  );
  const refresh = useCallback(async () => {
    if (!valid()) return;
    const version = ++refreshVersion.current;
    const latest = () => valid() && version === refreshVersion.current;
    try {
      let hasUnread = false;
      if (identity === "anonymous") {
        const loaded = loadAnonymousReads();
        anonymous.current = loaded.state;
        const first = notificationListSchema.parse(await request("notifications"));
        if (!anonymous.current) storeAnonymous({ through: first.upperBound, ids: [] });
        const state = anonymous.current!;
        let page = first;
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
            identity,
            hasUnread,
            error: null,
            storageError: loaded.storageError || loadAnonymousReads().storageError,
          });
      } else {
        const result = notificationUnreadSchema.parse(
          await request("account/notifications/unread"),
        );
        if (latest())
          setStatus({ identity, hasUnread: result.hasUnread, error: null, storageError: false });
      }
    } catch {
      if (latest())
        setStatus((old) => ({ ...old, identity, error: "お知らせを更新できませんでした。" }));
    }
  }, [identity, request, storeAnonymous, valid]);
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
      if (identity === "anonymous") {
        if (!anonymous.current) await list();
        const state = anonymous.current!;
        if (!isAnonymousRead(state, n.id, n.legacy))
          storeAnonymous({ ...state, ids: [...state.ids, n.id] });
      } else await request("account/notifications/read", { id: n.id });
      await refresh();
    },
    [identity, list, refresh, request, storeAnonymous],
  );
  const readAll = useCallback(
    async (through: number) => {
      if (identity === "anonymous")
        storeAnonymous({
          through: Math.max(through, anonymous.current?.through ?? 0),
          ids: (anonymous.current?.ids ?? []).filter((id) => id > through),
        });
      else await request("account/notifications/read-all", { through });
      await refresh();
    },
    [identity, refresh, request, storeAnonymous],
  );
  const readAnnouncement = useCallback(
    async (id: string) => {
      const page = notificationListSchema.parse(
        await request(`notifications?announcementId=${encodeURIComponent(id)}`),
      );
      if (page.notifications[0]) await read(page.notifications[0]);
    },
    [request, read],
  );
  const value = useMemo(
    () => ({
      identity,
      hasUnread: status.identity === identity && status.hasUnread,
      error: status.identity === identity ? status.error : null,
      storageError: status.identity === identity && status.storageError,
      registerHeader,
      refresh,
      list,
      detail: async (id: number) => notificationSchema.parse(await request(`notifications/${id}`)),
      read,
      readAll,
      readAnnouncement,
    }),
    [identity, status, registerHeader, refresh, list, request, read, readAll, readAnnouncement],
  );
  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}
