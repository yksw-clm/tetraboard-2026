import { type MouseEventHandler, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@heroui/react";
import { appPageWidthClasses } from "./pageLayout";
import { AppNavigation, type AppNavigationHandler } from "./AppNavigation";
import { BrowserSettingsButton } from "./BrowserSettings";
import type { AppTheme } from "./appTheme";

export function AppHeader({
  homeTo,
  homeLabel,
  onLogoClick,
  onNavigate,
  children,
  theme,
}: {
  homeTo: string;
  homeLabel: string;
  onLogoClick?: MouseEventHandler<HTMLAnchorElement>;
  onNavigate?: AppNavigationHandler;
  children?: ReactNode;
  theme?: AppTheme;
}) {
  return (
    <>
      <header className="border-0 border-b border-solid border-line bg-[#f9fbfac9]">
        <div
          className={cn(
            appPageWidthClasses,
            "flex min-h-[68px] items-center justify-between gap-5 [@media(max-width:1023px)]:gap-3 [@media(max-width:767px)]:gap-2 [@media(max-width:767px)]:min-h-[60px]",
          )}
        >
          <Link
            className="inline-flex shrink-0 items-center gap-3 text-[25px] font-[750] tracking-[-0.9px] text-ink no-underline [@media(max-width:1023px)]:gap-2 [@media(max-width:1023px)]:text-[19px]"
            to={homeTo}
            aria-label={homeLabel}
            onClick={onLogoClick}
          >
            <span className="grid size-8 place-items-center">
              <img
                className="block [@media(max-width:1023px)]:size-[26px]"
                src="/favicon.ico"
                width="28"
                height="28"
                alt=""
              />
            </span>
            <span>
              Tetra<span className="text-brand">Board</span>
            </span>
          </Link>
          <AppNavigation onNavigate={onNavigate} />
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-4 [@media(max-width:1023px)]:gap-2">
            <div className="[@media(max-width:767px)]:hidden">
              {children ?? (
                <span className="text-xs tracking-[0.06em] text-muted [@media(max-width:650px)]:hidden">
                  4人の遊びを、もっと気軽に。
                </span>
              )}
            </div>
            <BrowserSettingsButton theme={theme} />
          </div>
        </div>
      </header>
      <AppNavigation mobile onNavigate={onNavigate} />
    </>
  );
}
