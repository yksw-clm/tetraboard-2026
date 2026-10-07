import { Chip, cn } from "@heroui/react";

const rankClasses = {
  1: "bg-[#fff0ba] text-[#896315]",
  2: "bg-[#e0edff] text-[#376597]",
  3: "bg-[#f5e5d9] text-[#99633d]",
  4: "bg-[#e9ecef] text-[#62717b]",
} as const;

export function PlayerRankBadge({
  rank,
  label = `${rank}位`,
  className,
}: {
  rank: number;
  label?: string;
  className?: string;
}) {
  return (
    <Chip
      size="sm"
      className={cn(
        "h-[22px] py-[2px] px-1 rounded-[6px] font-bold whitespace-nowrap shrink-0",
        rankClasses[rank as keyof typeof rankClasses],
        className,
      )}
    >
      {label}
    </Chip>
  );
}
