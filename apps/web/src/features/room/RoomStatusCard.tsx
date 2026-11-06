import type { ReactNode } from "react";
import { AppCard } from "../../shared/ui/AppCard";

export function RoomStatusCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <AppCard
      aria-label="対局状況"
      className={`h-12 min-h-12 min-w-0 shrink-0 flex flex-row items-center gap-1 px-1.5 py-1 [&>button]:px-2 [@media(max-width:1279px)]:col-start-1 [@media(max-width:1279px)]:row-start-2 [@media(max-width:767px)]:mx-[2px] [@media(max-width:767px)]:gap-[3px] [@media(max-width:767px)]:[&>button]:px-1.5 ${className}`}
    >
      {children}
    </AppCard>
  );
}
