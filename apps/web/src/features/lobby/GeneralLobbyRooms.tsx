import { useRef } from "react";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppPendingIndicator } from "../../shared/ui/AppPendingIndicator";
import { AppCard } from "../../shared/ui/AppCard";
import { AppIcon } from "../../shared/ui/AppIcon";
import { AppSectionHeading } from "../../shared/ui/AppSectionHeading";
import type { LobbyRoom } from "@tetraboard/protocol/general-lobby";
import type { useGeneralLobbyRooms } from "./useGeneralLobbyRooms";
import { LobbyRoomCard, LobbyRoomLegend } from "./LobbyRoomCard";

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
      <div className="relative h-[400px] min-h-0 [@media(min-width:768px)]:h-full">
        <div
          ref={list}
          className="h-full min-h-0 overflow-y-auto overscroll-contain rounded-panel border border-solid border-line bg-surface-muted p-3 [scrollbar-width:thin]"
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
                const canJoin = room.status === "waiting" && room.openSeats > 0;
                return (
                  <li key={room.id}>
                    <LobbyRoomCard room={room} gameLink>
                      {room.tournamentId ? (
                        <AppButtonLink size="compact" to={`/tournaments/${room.tournamentId}`}>
                          大会へ
                        </AppButtonLink>
                      ) : (
                        room.status === "waiting" && (
                          <AppButton
                            size="compact"
                            isDisabled={!canJoin}
                            aria-label={`ルーム ${room.id} に参加`}
                            onPress={() => onRoomAction(room, "join")}
                          >
                            参加
                          </AppButton>
                        )
                      )}
                      <AppButton
                        size="compact"
                        appearance="secondary"
                        aria-label={`ルーム ${room.id} を観戦`}
                        onPress={() => onRoomAction(room, "watch")}
                      >
                        観戦
                      </AppButton>
                    </LobbyRoomCard>
                  </li>
                );
              })}
            </ul>
          ) : page.loaded && !page.error ? (
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
              <div className="flex w-full flex-col gap-3">
                {[4, 2].map((capacity) => (
                  <div key={capacity} role="group" aria-label={`${capacity}人プレイ`}>
                    <p className="mb-1.5 text-xs font-semibold text-muted">{capacity}人プレイ</p>
                    <div className="flex flex-wrap justify-center gap-2">
                      {gameIds
                        .filter((id) => gameCatalog[id].capacity === capacity)
                        .map((id) => (
                          <AppButtonLink
                            key={id}
                            size="compact"
                            to={gameCatalog[id].lobbyPath}
                            state={{ roomEntryIntent: "create" }}
                            className="px-2 text-xs"
                          >
                            {gameCatalog[id].name}
                          </AppButtonLink>
                        ))}
                    </div>
                  </div>
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
        {page.pendingSource === "refresh" && (
          <div
            role="status"
            aria-label="公開ルームを更新しています"
            className="pointer-events-none absolute inset-0 rounded-panel bg-white/60"
          >
            <AppPendingIndicator />
          </div>
        )}
      </div>
      <LobbyRoomLegend />
    </section>
  );
}
