import { Spinner } from "@heroui/react";

export const pendingButtonClasses =
  "relative data-[pending=true]:text-transparent! data-[pending=true]:[&>*:not([data-slot=pending-spinner])]:opacity-0";

export function AppPendingIndicator({ className }: { className?: string }) {
  return (
    <span
      data-slot="pending-spinner"
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 grid place-items-center ${className ?? "text-ink"}`}
    >
      <Spinner size="sm" color="current" />
    </span>
  );
}
