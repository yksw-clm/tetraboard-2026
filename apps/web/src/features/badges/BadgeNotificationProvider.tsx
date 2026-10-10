import { useEffect, useRef, useState, type ReactNode } from "react";
import { ToastQueue } from "@heroui/react";
import { AppToastContext, type AppToastContent } from "../../shared/ui/appToastContext";
import { AppToastRegion } from "../../shared/ui/AppToastRegion";
import { gameThemes } from "../../shared/ui/appTheme";
import { createUuid } from "../../shared/createUuid";
import { useAccount } from "../account/useAccount";
import { badgeNotificationRequest, BadgeNotificationRequestError } from "./badgeNotificationApi";
import { badgeNotificationResponseSchema, type BadgeNotification } from "@tetraboard/protocol";
import { BadgeToastDetails } from "./BadgeToastDetails";
import { badgeToastTitle } from "./badgeNotificationPresentation";

export function BadgeNotificationProvider({ children }: { children: ReactNode }) {
  const { user, loading, error } = useAccount();
  const identity = user?.profileId ?? user?.username ?? null;
  const [queue] = useState(() => new ToastQueue<AppToastContent>());
  const ready = useRef(false);
  useEffect(() => {
    ready.current = Boolean(user && !loading && !error);
  }, [user, loading, error]);
  useEffect(() => {
    // HeroUIのProviderが、非表示・ホバー・フォーカスを別々の停止理由として管理します。
    return () => queue.clear();
  }, [queue]);
  useEffect(() => {
    if (!identity) return;
    const token = createUuid();
    const controller = new AbortController();
    let stopped = false;
    let busy = false;
    let active: {
      notification: BadgeNotification;
      key: string;
      shown: boolean;
      acknowledged: boolean;
      closed: boolean;
    } | null = null;
    const seen = new Set<string>();
    const hidden = () => document.visibilityState === "hidden";
    const request = (operation: string, id?: string) =>
      badgeNotificationRequest(operation, token, controller.signal, id);
    const wake = () => {
      void run();
    };
    async function run() {
      if (stopped || busy) return;
      busy = true;
      try {
        if (active?.shown && !active.acknowledged) {
          try {
            await request("shown", active.notification.id);
            active.acknowledged = true;
          } catch (error) {
            if (stopped) return;
            if (error instanceof BadgeNotificationRequestError && error.status === 409) {
              const expired = active;
              active = null;
              queue.close(expired.key);
              return;
            }
            // 応答を失った表示済み記録も再送できます。未記録なら取得権を延長します。
            await request("renew", active.notification.id).catch(() => {});
            return;
          }
        }
        if (active?.closed && active.acknowledged) active = null;
        if (active || !ready.current || hidden() || queue.visibleToasts.length) return;
        const { notification } = badgeNotificationResponseSchema.parse(await request("claim"));
        if (stopped || !notification) return;
        if (!ready.current || hidden()) {
          await request("release", notification.id);
          return;
        }
        if (seen.has(notification.id)) {
          await request("shown", notification.id);
          return;
        }
        const current = { notification, key: "", shown: false, acknowledged: false, closed: false };
        active = current;
        const onShown = () => {
          if (stopped || current.shown) return;
          current.shown = true;
          seen.add(notification.id);
          // 描画後、取得処理の終了を待って表示済みを記録します。
          queueMicrotask(wake);
        };
        current.key = queue.add(
          {
            title: badgeToastTitle(notification),
            description: <BadgeToastDetails notification={notification} onShown={onShown} />,
            theme: gameThemes[notification.game],
            polite: true,
            centered: true,
            accountIdentity: identity ?? undefined,
          },
          {
            timeout: 5000,
            onClose: () => {
              current.closed = true;
              queueMicrotask(wake);
            },
          },
        );
      } catch {
        // 通知取得の失敗は対局・既存UIを妨げず、次の取得で再試行します。
      } finally {
        busy = false;
      }
    }
    wake();
    const timer = setInterval(wake, 5000);
    const unsubscribe = queue.subscribe(wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      unsubscribe();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      if (active) queue.close(active.key);
    };
  }, [identity, queue]);
  return (
    <AppToastContext.Provider value={queue}>
      {children}
      <AppToastRegion queue={queue} accountIdentity={identity} />
    </AppToastContext.Provider>
  );
}
