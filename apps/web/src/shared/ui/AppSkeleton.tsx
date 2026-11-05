import { Skeleton } from "@heroui/react/skeleton";
import { AppCard } from "./AppCard";

export function AppSkeleton({ className }: { className: string }) {
  return <Skeleton aria-hidden="true" animationType="none" className={className} />;
}

export function AppSkeletonCard({ className }: { className: string }) {
  return (
    <AppCard aria-hidden="true" className={`min-w-0 justify-between p-4 shadow-none ${className}`}>
      <div className="flex flex-col gap-3">
        <AppSkeleton className="h-4 w-1/2" />
        <AppSkeleton className="h-3 w-2/3" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <AppSkeleton className="h-5 w-1/3" />
        <AppSkeleton className="h-5 w-1/4" />
      </div>
    </AppCard>
  );
}
