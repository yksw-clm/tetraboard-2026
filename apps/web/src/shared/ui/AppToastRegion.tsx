import { Toast, type ToastQueue } from "@heroui/react";
import type { AppToastContent } from "./appToastContext";
import { appThemeClasses, type AppTheme } from "./appTheme";

export function AppToastRegion({
  queue,
  theme = "default",
  accountIdentity,
}: {
  queue: ToastQueue<AppToastContent>;
  theme?: AppTheme;
  accountIdentity?: string | null;
}) {
  return (
    <Toast.Provider
      queue={queue}
      placement="top"
      width="min(380px, calc(100vw - 24px))"
      className="z-[110000] [&_.toast]:border [&_.toast]:border-solid [&_.toast]:border-line [&_.toast]:bg-white [&_.toast]:rounded-[14px] [&_.toast]:shadow-[0_5px_28px_#193d2926]"
    >
      {({ toast }) =>
        toast.content.accountIdentity && toast.content.accountIdentity !== accountIdentity ? (
          <></>
        ) : (
          <Toast
            toast={toast}
            className={`app-theme ${appThemeClasses[toast.content.theme ?? theme]}`}
          >
            <Toast.Content
              className={
                toast.content.centered ? "min-w-0 flex-1 items-center text-center" : undefined
              }
              {...(toast.content.polite ? { role: "status", "aria-live": "polite" as const } : {})}
            >
              <Toast.Title>{toast.content.title}</Toast.Title>
              <Toast.Description
                className={`wrap-anywhere whitespace-pre-wrap ${toast.content.centered ? "w-full" : ""}`}
              >
                {toast.content.description}
              </Toast.Description>
            </Toast.Content>
            <Toast.CloseButton aria-label="通知を閉じる" />
          </Toast>
        )
      }
    </Toast.Provider>
  );
}
