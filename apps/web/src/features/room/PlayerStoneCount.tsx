import type { Color } from "@tetraboard/four-reversi";
import { colorNames } from "./stonePresentation";
import { Stone } from "./Stone";

export function PlayerStoneCount({ color, count }: { color: Color; count: number | null }) {
  return (
    <span
      data-testid="player-stone-count"
      className="inline-flex shrink-0 items-center gap-[6px] text-[13px] font-bold tabular-nums [@container(max-width:160px)]:text-[11px] [@container(max-width:160px)]:gap-[3px]"
      aria-label={`${colorNames[color]}${count === null ? "" : `、${count}石`}`}
    >
      <Stone
        color={color}
        className="size-[19px] shadow-[inset_0_-1px_2px_#0002] [@container(max-width:160px)]:size-4"
      />
      {count}
    </span>
  );
}
