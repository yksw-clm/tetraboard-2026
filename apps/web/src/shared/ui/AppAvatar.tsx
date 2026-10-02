import { Avatar, cn } from "@heroui/react";
import { AppIcon } from "./AppIcon";
export function AppAvatar({
  src,
  className,
  label = "",
}: {
  src: string | null;
  className?: string;
  label?: string;
}) {
  return (
    <Avatar className={cn("size-9 shrink-0 rounded-full bg-surface-hover text-ink", className)}>
      {src && <Avatar.Image src={src} alt={label} className="size-full object-cover" />}
      <Avatar.Fallback className="grid size-full place-items-center">
        <AppIcon name="user" />
      </Avatar.Fallback>
    </Avatar>
  );
}
