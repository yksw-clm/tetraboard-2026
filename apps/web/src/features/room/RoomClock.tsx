import { cn } from "@heroui/react";
import { type playerClock } from "./roomPresentation";

export function RoomClock({
  clock,
  describe = false,
  className,
}: {
  clock: NonNullable<ReturnType<typeof playerClock>>;
  describe?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-label={`${clock.byoyomi ? "秒読み" : "持ち時間"} ${clock.text}`}
      className={cn(
        "tabular-nums font-[650] whitespace-nowrap text-sm [@media(max-width:767px)]:text-xs",
        clock.urgent
          ? "text-[#d04444] animate-[room-urgency_1s_ease-in-out_infinite]"
          : clock.byoyomi
            ? "text-[#a97c0b]"
            : "text-ink",
        className,
      )}
    >
      {describe && (clock.byoyomi ? "秒読み " : "残り ")}
      {clock.text}
    </span>
  );
}
