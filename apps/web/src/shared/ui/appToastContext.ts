import { createContext, useContext, useState } from "react";
import { ToastQueue } from "@heroui/react";
import type { ReactNode } from "react";
import type { AppTheme } from "./appTheme";

export type AppToastContent = {
  title: ReactNode;
  description: ReactNode;
  theme?: AppTheme;
  polite?: boolean;
  centered?: boolean;
  accountIdentity?: string;
};
export const AppToastContext = createContext<ToastQueue<AppToastContent> | null>(null);
export function useAppToastQueue() {
  const shared = useContext(AppToastContext);
  const [local] = useState(() => new ToastQueue<AppToastContent>());
  return { queue: shared ?? local, shared: Boolean(shared) };
}
