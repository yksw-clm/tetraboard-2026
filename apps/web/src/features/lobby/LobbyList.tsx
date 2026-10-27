import { useRef, useState } from "react";
import type { LobbyRoomCard as RoomCardData } from "@tetraboard/protocol/general-lobby";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import { AppPendingIndicator } from "../../shared/ui/AppPendingIndicator";
import { LobbyRoomCard } from "./LobbyRoomCard";
import type { CapacityFilter, ModeFilter } from "./useGeneralLobbyRooms";

type Props = {
  game?: GameId;
  rooms: RoomCardData[];
  totalCount?: number;
  error: string | null;
  loading: boolean;
  isInitialLoading: boolean;
  hasData?: boolean;
  pendingSource?: string | null;
  pendingWatchRoomId?: string;
  capacity?: CapacityFilter;
  modeFilter?: ModeFilter;
  joinable?: boolean;
  changeCapacity?: (value: CapacityFilter) => void;
  changeMode?: (value: ModeFilter) => void;
  changeJoinable?: (value: boolean) => void;
  onCreate?: () => void;
  onRefresh: () => void;
  onJoin: (roomId: string, humanOnly?: boolean, instanceId?: string) => void;
  onWatch: (roomId: string, instanceId?: string) => void;
};
export function LobbyList({
  game,
  rooms,
  totalCount = rooms.length,
  error,
  loading,
  isInitialLoading,
  hasData = false,
  pendingSource,
  pendingWatchRoomId,
  capacity = "all",
  modeFilter = "all",
  joinable = false,
  changeCapacity,
  changeMode,
  changeJoinable,
  onCreate,
  onRefresh,
  onJoin,
  onWatch,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const general = !game;
  const empty = rooms.length === 0 && !isInitialLoading && (!error || hasData);
  const visible = general || expanded ? rooms : rooms.slice(0, 3);
  function reset() {
    setExpanded(false);
    if (list.current) list.current.scrollTop = 0;
  }
  const filters = general
    ? [
        { value: "all", label: "すべて" },
        { value: "4", label: "四人用" },
        { value: "2", label: "二人用" },
      ]
    : gameCatalog[game].hasModes
      ? [
          { value: "all", label: "すべて" },
          { value: "singles", label: "シングルス" },
          { value: "doubles", label: "ダブルス" },
        ]
      : [];
  return (
    <section
      aria-labelledby="public-rooms-title"
      className={general ? "min-w-0" : "flex h-full min-w-0 flex-col"}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 id="public-rooms-title" className="text-xl font-bold">
            {general ? "公開ルーム一覧" : "公開ルーム"}
          </h2>
          <span className="text-xs text-muted">
            {totalCount}
            {general ? "件" : "部屋"}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {onCreate && (
            <AppButton onPress={onCreate}>
              <AppIcon name="plus" />
              ルームを作る
            </AppButton>
          )}
          <AppButton
            size="compact"
            appearance="quiet"
            className="px-2"
            aria-label="公開ルームを更新"
            onPress={onRefresh}
            isDisabled={loading}
            isPending={pendingSource === "refresh"}
          >
            <AppIcon name="refresh" />
            <span className="sr-only">更新</span>
          </AppButton>
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {filters.length > 0 && (
          <div
            role="group"
            aria-label={general ? "公開ルームの人数" : "公開ルームの対局モード"}
            className="inline-flex rounded-full bg-primary/5 p-1"
          >
            {filters.map((filter) => (
              <AppButton
                key={filter.value}
                size="compact"
                appearance={
                  String(general ? capacity : modeFilter) === filter.value ? "primary" : "quiet"
                }
                aria-pressed={String(general ? capacity : modeFilter) === filter.value}
                className="min-h-9 rounded-full px-4 text-xs"
                onPress={() => {
                  reset();
                  if (general)
                    changeCapacity?.(
                      filter.value === "all" ? "all" : (Number(filter.value) as 2 | 4),
                    );
                  else changeMode?.(filter.value as ModeFilter);
                }}
              >
                {filter.label}
              </AppButton>
            ))}
          </div>
        )}
        <label className="ml-auto inline-flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={joinable}
            className="size-[18px] accent-primary"
            onChange={(event) => {
              reset();
              changeJoinable?.(event.currentTarget.checked);
            }}
          />
          参加できるルームのみ
        </label>
      </div>
      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}「更新」からもう一度お試しください。
        </p>
      )}
      <div className={empty && !general ? "relative flex min-h-0 flex-1 flex-col" : "relative"}>
        <div
          ref={list}
          className={
            empty && !general
              ? "flex min-h-0 flex-1 flex-col"
              : general
                ? "max-h-[480px] overflow-y-auto overscroll-contain [scrollbar-width:thin] [@media(max-width:767px)]:max-h-[400px]"
                : expanded
                  ? "max-h-[720px] overflow-y-auto overscroll-contain [scrollbar-width:thin] [@media(max-width:767px)]:max-h-[400px]"
                  : ""
          }
        >
          {isInitialLoading && (
            <p role="status" className="py-8 text-sm text-muted">
              公開ルームを読み込んでいます…
            </p>
          )}
          {visible.length > 0 && (
            <ul
              aria-label="公開ルーム一覧"
              tabIndex={general || expanded ? 0 : undefined}
              className={`m-0 grid list-none gap-3 p-0 ${general ? "grid-cols-2 [@media(max-width:767px)]:grid-cols-1" : "grid-cols-1"}`}
            >
              {visible.map((room) => (
                <li key={`${room.id}:${room.instanceId}`} className="min-w-0">
                  <LobbyRoomCard room={room} gameLink={general}>
                    <AppButton
                      size="compact"
                      appearance="secondary"
                      className="min-h-11 px-3 text-xs"
                      aria-label={`ルーム ${room.id} を観戦`}
                      isPending={pendingWatchRoomId === room.id}
                      onPress={() => onWatch(room.id, room.instanceId)}
                    >
                      <AppIcon name="eye" className="size-4" />
                      観戦
                    </AppButton>
                    {room.tournamentId ? (
                      <AppButtonLink
                        size="compact"
                        className="min-h-11 px-3 text-xs"
                        to={`/tournaments/${room.tournamentId}`}
                      >
                        大会へ
                      </AppButtonLink>
                    ) : (
                      <AppButton
                        size="compact"
                        className="min-h-11 px-3 text-xs"
                        isDisabled={room.status !== "waiting" || room.openSeats === 0}
                        aria-label={`ルーム ${room.id} に参加`}
                        onPress={() => onJoin(room.id, room.cpuCount === 0, room.instanceId)}
                      >
                        <AppIcon name="join" className="size-4" />
                        参加する
                      </AppButton>
                    )}
                  </LobbyRoomCard>
                </li>
              ))}
            </ul>
          )}
          {empty && (
            <AppCard
              className={`${general ? "min-h-[140px]" : "min-h-[240px] flex-1"} items-center justify-center gap-2 border-dashed p-5 text-center shadow-none`}
            >
              <AppIcon name="users" className="text-primary" />
              <h3 className="text-[15px]">
                {joinable
                  ? "参加できる公開ルームはありません"
                  : general && capacity !== "all"
                    ? `${capacity === 4 ? "四人" : "二人"}用の公開ルームはありません`
                    : modeFilter !== "all"
                      ? `${modeFilter === "singles" ? "シングルス" : "ダブルス"}の公開ルームはありません`
                      : "公開ルームはまだありません"}
              </h3>
              <p className="text-xs text-muted">CPUと遊ぶか、ルームを作って友達を招待できます。</p>
            </AppCard>
          )}
        </div>
        {pendingSource === "refresh" && (
          <div
            role="status"
            aria-label="公開ルームを更新しています"
            className="pointer-events-none absolute inset-0 rounded-panel bg-white/60"
          >
            <span className="sr-only">公開ルームを読み込んでいます…</span>
            <AppPendingIndicator />
          </div>
        )}
      </div>
      {!general && (rooms.length > 3 || expanded) && (
        <AppButton
          appearance="secondary"
          className="mt-3 w-full min-h-11 text-sm"
          aria-expanded={expanded}
          onPress={() => {
            setExpanded(!expanded);
            if (list.current) list.current.scrollTop = 0;
          }}
        >
          <AppIcon name="chevronDown" className={expanded ? "rotate-180" : ""} />
          {expanded ? "ルームを折りたたむ" : `すべてのルームを見る（${totalCount}部屋）`}
        </AppButton>
      )}
    </section>
  );
}
