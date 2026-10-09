import type { ReactNode } from "react";
export function ReversiBoardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="[--player-height:60px] [@media(max-width:767px)]:[--player-height:48px] [--board-size:max(0px,min(640px,100cqw,calc(100cqh_-_2_*_var(--player-height)_-_32px)))] [--seat-width:var(--board-size)] grid min-h-full w-full grid-cols-[var(--board-size)] grid-rows-[var(--player-height)_var(--board-size)_var(--player-height)] [grid-template-areas:'top'_'board'_'bottom'] content-center justify-center gap-2 [@media(max-width:767px)]:gap-[2px] [@media(max-width:767px)]:[--board-size:max(0px,min(100cqw,calc(100cqh_-_2_*_var(--player-height)_-_21px)))]">
      {children}
    </div>
  );
}
