import type { MatchKind } from "@tetraboard/protocol";

const presentations = {
  rated: { label: "レート戦", color: "bg-[#eaf2ff] text-[#315e98]" },
  tournament: { label: "大会戦", color: "bg-[#f2ebff] text-[#6c409a]" },
  normal: { label: "通常対局", color: "bg-surface-muted text-muted" },
  unknown: { label: "種別不明", color: "bg-surface-muted text-muted" },
} satisfies Record<MatchKind, { label: string; color: string }>;

export function MatchKindBadge({ kind = "unknown" }: { kind?: MatchKind }) {
  const { label, color } = presentations[kind];
  return (
    <span
      aria-label={`対局種別: ${label}`}
      className={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold whitespace-nowrap ${color}`}
    >
      {label}
    </span>
  );
}
