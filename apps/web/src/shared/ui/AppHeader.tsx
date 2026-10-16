import { type MouseEventHandler, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@heroui/react";
import { appPageWidthClasses } from "./pageLayout";
import { AppButtonLink } from "./AppButton";
import { BrowserSettingsButton } from "./BrowserSettings";
import type { AppTheme } from "./appTheme";

export function AppHeader({
  homeTo,
  homeLabel,
  onLogoClick,
  children,
  theme,
}: {
  homeTo: string;
  homeLabel: string;
  onLogoClick?: MouseEventHandler<HTMLAnchorElement>;
  children?: ReactNode;
  theme?: AppTheme;
}) {
  return (
    <header className="border-0 border-b border-solid border-line bg-[#f9fbfac9]">
      <div
        className={cn(
          appPageWidthClasses,
          "flex flex-wrap min-h-[68px] items-center justify-between gap-5 [@media(max-width:650px)]:gap-2 [@media(max-width:650px)]:min-h-[60px]",
        )}
      >
        <Link
          className="inline-flex items-center gap-3 text-[25px] font-[750] tracking-[-0.9px] text-ink no-underline [@media(max-width:650px)]:gap-2 [@media(max-width:650px)]:text-[19px]"
          to={homeTo}
          aria-label={homeLabel}
          onClick={onLogoClick}
        >
          <span className="grid size-[42px] [@media(max-width:650px)]:size-8 place-items-center rounded-[12px] border border-solid border-[#e6ebe8] bg-white shadow-[0_3px_8px_#193c2310]">
            <img
              className="block [@media(max-width:650px)]:size-[26px]"
              src="/favicon.ico"
              width="34"
              height="34"
              alt=""
            />
          </span>
          <span>
            Tetra<span className="text-brand">Board</span>
          </span>
        </Link>
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-4">
          <AppButtonLink
            to="/updates"
            appearance="secondary"
            size="compact"
            className="min-h-11 px-2 text-xs sm:px-3 sm:text-sm"
          >
            お知らせ
          </AppButtonLink>
          {children ?? (
            <span className="text-xs tracking-[0.06em] text-muted [@media(max-width:650px)]:hidden">
              4人の遊びを、もっと気軽に。
            </span>
          )}
          <BrowserSettingsButton theme={theme} />
        </div>
      </div>
    </header>
  );
}
