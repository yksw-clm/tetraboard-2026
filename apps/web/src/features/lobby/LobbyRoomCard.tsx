import { Link } from "react-router";
import type { ReactNode } from "react";
import type { LobbyRoomCard as RoomCardData } from "@tetraboard/protocol/general-lobby";
import { gameCatalog } from "@tetraboard/protocol/games";
import { AppCard } from "../../shared/ui/AppCard";
import { AppIcon } from "../../shared/ui/AppIcon";
import { gameThemes } from "../../shared/ui/appTheme";
import { PlayerProfileTrigger } from "../players/PlayerProfileTrigger";
import { PlayerAvatar } from "../room/PlayerAvatar";
import { LobbyBoardPreview } from "./LobbyBoardPreview";

function duration(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
export function LobbyRoomCard({
  room,
  gameLink = false,
  children,
}: {
  room: RoomCardData;
  gameLink?: boolean;
  children: ReactNode;
}) {
  const host = room.hostName ?? "ホストなし";
  const participants = room.participants;
  const status = room.status === "playing" ? "対局中" : room.openSeats > 0 ? "募集中" : "満員";
  const gameName = gameCatalog[room.game].name;
  return (
    <AppCard className="h-full gap-3 rounded-[18px] px-4 py-3.5">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center">
          <LobbyBoardPreview game={room.game} compact className="!w-11 !rotate-0 !shadow-none" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold text-muted">
            <span>
              {gameLink ? (
                <Link
                  to={gameCatalog[room.game].lobbyPath}
                  className="text-inherit no-underline hover:underline"
                >
                  {gameName}
                </Link>
              ) : (
                gameName
              )}
              {room.mode && `・${room.mode === "singles" ? "シングルス" : "ダブルス"}`}
            </span>
            <span className="inline-flex items-center gap-1 whitespace-nowrap font-normal tabular-nums">
              <AppIcon name="clock" className="size-3.5" />
              {duration(room.timeControl.mainTimeMs)} / {duration(room.timeControl.byoyomiMs)}
            </span>
          </div>
          <strong className="block text-[15px] leading-6 wrap-anywhere">
            <PlayerProfileTrigger
              target={room.hostName === null ? null : room.profileTarget}
              game={room.game}
              mode={room.mode ?? "singles"}
              theme={gameThemes[room.game]}
              label={host}
            >
              {host}
            </PlayerProfileTrigger>
            の部屋
          </strong>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-[11px] font-bold">
          <span className="rounded-full bg-surface-hover px-2 py-0.5 text-muted tabular-nums">
            #{room.id}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 ${room.status === "playing" ? "bg-[#edf3fb] text-[#456a9c]" : room.openSeats > 0 ? "bg-primary/10 text-ink" : "bg-surface-hover text-muted"}`}
          >
            {status}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
        <div className="flex items-center gap-2">
          <span
            role="group"
            aria-label={`人間${room.humanCount}人、CPU${room.cpuCount}人、空席${room.capacity - participants.length}席`}
            className="inline-flex items-center gap-1"
          >
            {participants.map((appearance, index) => (
              <PlayerProfileTrigger
                key={
                  appearance.kind === "human" && appearance.profileTarget
                    ? appearance.profileTarget.playerId
                    : index
                }
                target={appearance.kind === "human" ? appearance.profileTarget : undefined}
                localProfile={appearance.kind === "cpu" ? appearance : undefined}
                game={room.game}
                mode={room.mode ?? "singles"}
                theme={gameThemes[room.game]}
                label={
                  appearance.kind === "cpu"
                    ? `CPU Lv${appearance.level}`
                    : `ルーム${room.id}の参加者${index + 1}`
                }
              >
                <PlayerAvatar appearance={appearance} className="size-7 [&_svg]:size-4" />
              </PlayerProfileTrigger>
            ))}
            {Array.from(
              { length: Math.max(0, room.capacity - participants.length) },
              (_, index) => (
                <span
                  key={`empty-${index}`}
                  aria-hidden="true"
                  className="size-7 rounded-full border border-dashed border-line bg-surface-muted"
                />
              ),
            )}
          </span>
          <span className="text-xs font-semibold text-muted tabular-nums">
            {room.humanCount + room.cpuCount} / {room.capacity}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">{children}</div>
      </div>
    </AppCard>
  );
}
