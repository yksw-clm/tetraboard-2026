import { Spinner } from "@heroui/react";
import type { ReactNode } from "react";
import { appThemeClasses, type AppTheme } from "./appTheme";

export function AppPageState({
  children,
  theme = "default",
}: {
  children: ReactNode;
  theme?: AppTheme;
}) {
  return (
    <main
      className={`app-theme ${appThemeClasses[theme]} lobby-background flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center text-sm text-ink leading-normal wrap-anywhere`}
    >
      {children}
    </main>
  );
}

export function AppPageLoading({ message, theme }: { message: string; theme?: AppTheme }) {
  return (
    <AppPageState theme={theme}>
      <div role="status" className="flex flex-col items-center gap-3 text-muted">
        <Spinner color="accent" size="lg" aria-hidden="true" />
        <p>{message}</p>
      </div>
    </AppPageState>
  );
}
