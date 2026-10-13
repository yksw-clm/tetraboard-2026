import { Chip } from "@heroui/react";
import type { ReactNode } from "react";
import { GameBadge } from "../../shared/ui/GameBadge";
import type { PreviewRoomMetadata } from "@tetraboard/protocol";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppCard } from "../../shared/ui/AppCard";
import { AppIcon } from "../../shared/ui/AppIcon";
import { gameThemes } from "../../shared/ui/appTheme";
import { PlayerProfileTrigger } from "../players/PlayerProfileTrigger";

export function LobbyRoomCard({
  room,
  gameLink = false,
  showGame = true,
  children,
}: {
  room: PreviewRoomMetadata;
  gameLink?: boolean;
  showGame?: boolean;
  children: ReactNode;
}) {
  const host = room.hostName ?? "ホストなし";
  const profile = {
    target: room.hostName === null ? null : room.profileTarget,
    game: room.game,
    mode: room.mode ?? ("singles" as const),
    theme: gameThemes[room.game],
    label: host,
  };
  return (
    <AppCard className="h-full gap-2.5 px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {showGame && <GameBadge game={room.game} link={gameLink} />}
          {room.mode && (
            <span className="text-xs text-muted">
              {room.mode === "singles" ? "シングルス" : "ダブルス"}
            </span>
          )}
        </div>
        <Chip
          className={`rounded-[20px] px-2.5 py-1 text-[11px] font-semibold ${room.status === "playing" ? "bg-[#fcf5e4] text-[#806323]" : "bg-[#edf7f0] text-[#27794f]"}`}
        >
          <Chip.Label className="inline-flex items-center gap-1.5">
            <span className="size-[5px] rounded-full bg-current" />
            {room.status === "playing" ? "対局中" : "対局前"}
          </Chip.Label>
        </Chip>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <PlayerProfileTrigger {...profile}>
            <AppAvatar src={room.hostAvatarUrl} label={`${host}のアイコン`} />
          </PlayerProfileTrigger>
          <div className="min-w-0">
            <strong className="block text-sm wrap-anywhere">
              <PlayerProfileTrigger {...profile}>{host}</PlayerProfileTrigger>
            </strong>
            <span className="inline-flex flex-wrap items-center gap-2 text-[11px] text-muted tabular-nums">
              {room.id}
              <span className="inline-flex items-center gap-1">
                <AppIcon name="clock" className="size-3" />
                {`${room.timeControl.mainTimeMs / 60000}分＋${room.timeControl.byoyomiMs / 1000}秒`}
              </span>
            </span>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <div className="flex items-center gap-2">
            <strong className="text-sm tabular-nums">
              {room.humanCount + room.cpuCount}/{room.capacity}
            </strong>
            <span
              role="img"
              aria-label={`人間${room.humanCount}人、CPU${room.cpuCount}人、空席${room.capacity - room.humanCount - room.cpuCount}席`}
              className="inline-flex gap-1"
            >
              {Array.from({ length: room.capacity }, (_, index) => (
                <span
                  key={index}
                  className={`size-2 rounded-full ${index < room.humanCount ? "bg-[#34a871]" : index < room.humanCount + room.cpuCount ? "bg-[#376597]" : "bg-[#cbd3ce]"}`}
                />
              ))}
            </span>
          </div>
          <div className="flex gap-2">{children}</div>
        </div>
      </div>
    </AppCard>
  );
}

export function LobbyRoomLegend() {
  return (
    <div className="mt-2.5 text-[11px] text-muted">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {[
          ["人間", "bg-[#34a871]"],
          ["CPU", "bg-[#376597]"],
          ["空席", "bg-[#cbd3ce]"],
        ].map(([label, color]) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={`size-2 rounded-full ${color}`} />
            {label}
          </span>
        ))}
      </p>
    </div>
  );
}
