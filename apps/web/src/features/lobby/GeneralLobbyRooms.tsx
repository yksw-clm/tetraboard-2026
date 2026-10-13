import { Chip } from "@heroui/react";
import { useRef } from "react";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { Link } from "react-router";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppIcon } from "../../shared/ui/AppIcon";
import { AppSectionHeading } from "../../shared/ui/AppSectionHeading";
import { appThemeClasses, gameThemes } from "../../shared/ui/appTheme";
import type { LobbyRoom } from "@tetraboard/protocol/general-lobby";
import type { useGeneralLobbyRooms } from "./useGeneralLobbyRooms";

const filters = [
  { value: "all" as const, label: "すべて" },
  { value: 4 as const, label: "四人" },
  { value: 2 as const, label: "二人" },
];
export function GeneralLobbyRooms({
  page,
  onRoomAction,
}: {
  page: ReturnType<typeof useGeneralLobbyRooms>;
  onRoomAction: (room: LobbyRoom, intent: "join" | "watch") => void;
}) {
  const { capacity: capacityFilter, rooms: visibleRooms } = page;
  const list = useRef<HTMLDivElement>(null);
  return (
    <section
      aria-labelledby="public-rooms-title"
      className="min-w-0 [@media(min-width:768px)]:row-span-3 [@media(min-width:768px)]:grid [@media(min-width:768px)]:grid-rows-subgrid"
    >
      <div className="min-w-0">
        <AppSectionHeading
          id="public-rooms-title"
          title="公開ルーム"
          description="全ゲームの対戦募集と、対局中のルームを見つけられます。"
        >
          <AppButton
            size="compact"
            appearance="quiet"
            onPress={page.refresh}
            isPending={page.pendingSource === "refresh"}
            isDisabled={page.loading}
          >
            <AppIcon name="refresh" />
            更新
          </AppButton>
        </AppSectionHeading>
        <div
          role="group"
          aria-label="公開ルームの人数"
          className="mb-2.5 inline-flex gap-1 rounded-full bg-surface-muted p-1"
        >
          {filters.map((filter) => (
            <AppButton
              key={filter.value}
              size="compact"
              appearance={capacityFilter === filter.value ? "primary" : "quiet"}
              aria-pressed={capacityFilter === filter.value}
              className="min-h-8 rounded-full px-3 text-xs"
              onPress={() => {
                page.changeCapacity(filter.value);
                if (list.current) list.current.scrollTop = 0;
              }}
            >
              {filter.label}
            </AppButton>
          ))}
        </div>
      </div>
      <div
        ref={list}
        className="h-[400px] min-h-0 overflow-y-auto overscroll-contain [scrollbar-width:thin] [@media(min-width:768px)]:h-full"
      >
        {page.error && (
          <p role="alert" className="text-sm text-danger">
            {page.error}
          </p>
        )}
        {page.loading && !page.loaded && (
          <p role="status" className="text-sm text-muted">
            公開ルームを読み込んでいます…
          </p>
        )}
        {visibleRooms.length > 0 ? (
          <ul aria-label="公開ルーム一覧" tabIndex={0} className="m-0 grid list-none gap-2.5 p-0">
            {visibleRooms.map((room) => {
              const game = gameCatalog[room.game];
              const openSeats = game.capacity - room.humanCount - room.cpuCount;
              const canJoin = room.status === "waiting" && room.openSeats > 0;
              return (
                <li key={room.id}>
                  <AppCard className="gap-2.5 px-4 py-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Link
                          to={game.lobbyPath}
                          className={`${appThemeClasses[gameThemes[room.game]]} rounded-control bg-surface-muted px-2 py-1 text-xs font-semibold text-brand no-underline hover:underline`}
                        >
                          {game.name}
                        </Link>
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
                        <AppAvatar src={room.hostAvatarUrl} label={`${room.hostName}のアイコン`} />
                        <div className="min-w-0">
                          <strong className="block text-sm wrap-anywhere">{room.hostName}</strong>
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
                            {room.humanCount + room.cpuCount}/{game.capacity}
                          </strong>
                          <span
                            role="img"
                            aria-label={`人間${room.humanCount}人、CPU${room.cpuCount}人、空席${openSeats}席`}
                            className="inline-flex gap-1"
                          >
                            {Array.from({ length: game.capacity }, (_, index) => (
                              <span
                                key={index}
                                className={`size-2 rounded-full ${index < room.humanCount ? "bg-[#34a871]" : index < room.humanCount + room.cpuCount ? "bg-[#376597]" : "bg-[#cbd3ce]"}`}
                              />
                            ))}
                          </span>
                        </div>
                        <div className="flex gap-2">
                          {room.status === "waiting" && (
                            <AppButton
                              size="compact"
                              isDisabled={!canJoin}
                              aria-label={`ルーム ${room.id} に参加`}
                              onPress={() => onRoomAction(room, "join")}
                            >
                              参加
                            </AppButton>
                          )}
                          <AppButton
                            size="compact"
                            appearance="secondary"
                            aria-label={`ルーム ${room.id} を観戦`}
                            onPress={() => onRoomAction(room, "watch")}
                          >
                            観戦
                          </AppButton>
                        </div>
                      </div>
                    </div>
                  </AppCard>
                </li>
              );
            })}
          </ul>
        ) : !page.loading && !page.error ? (
          <AppCard className="h-full min-h-0 items-center justify-center gap-3 border-dashed text-center shadow-none">
            <span className="grid size-11 place-items-center rounded-[13px] bg-surface-muted text-brand">
              <AppIcon name="users" />
            </span>
            <h3 className="text-[15px]">
              {capacityFilter === "all"
                ? "公開ルームはまだありません"
                : `${capacityFilter === 4 ? "四人" : "二人"}用の公開ルームはありません`}
            </h3>
            <p className="text-xs leading-6 text-muted">
              公開チャットで対戦を呼びかけたり、
              <br />
              ゲームタブからルームを作ったりできます。
            </p>
            <div className="flex flex-wrap justify-center gap-x-3 gap-y-1">
              {gameIds.map((id) => (
                <Link
                  key={id}
                  to={gameCatalog[id].lobbyPath}
                  className="inline-flex min-h-11 items-center text-xs text-brand underline"
                >
                  {gameCatalog[id].name}
                </Link>
              ))}
            </div>
          </AppCard>
        ) : null}
        {page.nextCursor && (
          <AppButton
            appearance="secondary"
            size="compact"
            isDisabled={page.loading}
            isPending={page.pendingSource === "more"}
            onPress={page.loadMore}
          >
            もっと見る
          </AppButton>
        )}
      </div>
      <div className="mt-2.5 text-[11px] text-muted">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2 rounded-full bg-[#34a871]" />
            人間
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2 rounded-full bg-[#376597]" />
            CPU
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2 rounded-full bg-[#cbd3ce]" />
            空席
          </span>
        </p>
        <p className="mt-1">対局中は開始時の参加人数を表示しています。</p>
      </div>
    </section>
  );
}
