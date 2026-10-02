import { Avatar } from "@heroui/react";
import { RoomIcon } from "../features/room/RoomIcon";
export function PlayerAvatar({
  avatarUrl,
  kind,
  level,
  className = "",
}: {
  avatarUrl?: string | null;
  kind?: "human" | "cpu";
  level?: 1 | 2 | null;
  className?: string;
}) {
  return (
    <Avatar
      className={`player-avatar ${className} ${kind === "cpu" ? `cpu-level-${level ?? 1}` : ""}`}
      aria-hidden="true"
    >
      {avatarUrl && kind !== "cpu" && <Avatar.Image src={avatarUrl} alt="" />}
      <Avatar.Fallback>
        <RoomIcon name={kind === "cpu" ? "robot" : "user"} />
      </Avatar.Fallback>
    </Avatar>
  );
}
