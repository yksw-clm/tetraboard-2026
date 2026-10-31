import { type MouseEventHandler, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@heroui/react";
import { appPageWidthClasses } from "./pageLayout";
import { AppNavigation, type AppNavigationHandler } from "./AppNavigation";
import { BrowserSettingsButton } from "./BrowserSettings";
import type { AppTheme } from "./appTheme";
import { useActiveTournaments } from "../../features/tournaments/useActiveTournaments";
import { AppIcon } from "./AppIcon";

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
  const { tournaments } = useActiveTournaments();
  const active = tournaments[0];
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
            {active && (
              <Link
                to={`/tournaments/${active.id}`}
                aria-label={`${active.name} 開催中${tournaments.length > 1 ? `（ほか${tournaments.length - 1}件）` : ""}`}
                className="inline-flex min-h-11 items-center gap-1 rounded-control px-1 text-[11px] font-bold text-brand no-underline hover:bg-surface-muted focus-visible:outline-[3px] focus-visible:outline-focus md:gap-2 md:px-2 md:text-xs"
                onClick={(event) => {
                  if (
                    !onNavigate ||
                    event.defaultPrevented ||
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  onNavigate(`/tournaments/${active.id}`);
                }}
              >
                <AppIcon name="trophy" className="size-4" />
                <span>
                  大会開催中
                  {tournaments.length > 1 && (
                    <span className="ml-1">+{tournaments.length - 1}</span>
                  )}
                </span>
              </Link>
            )}
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
