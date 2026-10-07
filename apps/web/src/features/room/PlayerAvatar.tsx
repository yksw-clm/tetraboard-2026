import { Avatar, cn } from "@heroui/react";
import type { PlayerAppearance } from "@tetraboard/protocol";
import { AppIcon } from "../../shared/ui/AppIcon";

export function PlayerAvatar({
  appearance,
  className,
}: {
  appearance?: PlayerAppearance | null;
  className?: string;
}) {
  return (
    <Avatar
      data-testid="player-avatar"
      title={appearance?.kind === "cpu" ? "CPU" : undefined}
      className={cn(
        "min-w-0 min-h-0 aspect-square rounded-full shrink-0",
        appearance?.kind === "cpu" ? "bg-[#e0edff] text-[#376597]" : "bg-[#e1e6e3] text-[#7a8880]",
        className,
      )}
      aria-hidden="true"
    >
      {appearance?.kind === "human" && appearance.avatarUrl && (
        <Avatar.Image src={appearance.avatarUrl} alt="" className="size-full object-cover" />
      )}
      <Avatar.Fallback className="bg-transparent text-inherit">
        <AppIcon name={appearance?.kind === "cpu" ? "robot" : "user"} className="block size-5" />
      </Avatar.Fallback>
    </Avatar>
  );
}
