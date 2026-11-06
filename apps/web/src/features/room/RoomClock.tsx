import { cn } from "@heroui/react";
export type RoomClockPresentation = { text: string; byoyomi: boolean; urgent: boolean };

export function RoomClock({ clock }: { clock: RoomClockPresentation }) {
  return (
    <span
      aria-label={`${clock.byoyomi ? "秒読み" : "持ち時間"} ${clock.text}`}
      className={cn(
        "tabular-nums font-normal whitespace-nowrap text-xl leading-none [@media(max-width:767px)]:text-lg [@container(max-width:112px)]:text-sm",
        clock.urgent ? "text-[#b82733]" : clock.byoyomi ? "text-[#a97c0b]" : "text-ink",
      )}
    >
      {clock.text}
    </span>
  );
}
