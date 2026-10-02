import { type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@heroui/react";
import { appPageWidthClasses } from "./pageLayout";

export function AppHeader({
  homeTo,
  homeLabel,
  children,
}: {
  homeTo: string;
  homeLabel: string;
  children?: ReactNode;
}) {
  return (
    <header className="border-0 border-b border-solid border-line bg-[#f9fbfac9]">
      <div
        className={cn(
          appPageWidthClasses,
          "flex min-h-[68px] items-center justify-between gap-5 [@media(max-width:650px)]:gap-2 [@media(max-width:650px)]:min-h-[60px]",
        )}
      >
        <Link
          className="inline-flex items-center gap-3 text-[25px] font-[750] tracking-[-0.9px] text-ink no-underline [@media(max-width:650px)]:gap-2 [@media(max-width:650px)]:text-[19px]"
          to={homeTo}
          aria-label={homeLabel}
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
        {children ?? (
          <span className="text-xs tracking-[0.06em] text-muted [@media(max-width:650px)]:hidden">
            4人の遊びを、もっと気軽に。
          </span>
        )}
      </div>
    </header>
  );
}
