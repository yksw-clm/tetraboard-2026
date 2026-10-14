import { AppSectionHeading } from "../../shared/ui/AppSectionHeading";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton } from "../../shared/ui/AppButton";
import { type PreviewRoomMetadata } from "@tetraboard/protocol";
import { AppIcon } from "../../shared/ui/AppIcon";
import { LobbyRoomCard, LobbyRoomLegend } from "./LobbyRoomCard";

type Props = {
  rooms: PreviewRoomMetadata[];
  nextCursor: string | null;
  error: string | null;
  loading: boolean;
  isInitialLoading: boolean;
  moreLoading: boolean;
  pendingSource?: string | null;
  pendingWatchRoomId?: string;
  onRefresh: () => void;
  onLoadMore: () => void;
  onJoin: (roomId: string, humanOnly?: boolean) => void;
  onWatch: (roomId: string) => void;
};

export function LobbyList({
  rooms,
  nextCursor,
  error,
  loading,
  isInitialLoading,
  moreLoading,
  pendingSource,
  pendingWatchRoomId,
  onRefresh,
  onLoadMore,
  onJoin,
  onWatch,
}: Props) {
  return (
    <section
      aria-labelledby="public-rooms-title"
      className="min-w-0 [@media(min-width:768px)]:col-span-2"
    >
      <AppSectionHeading
        id="public-rooms-title"
        title="公開ルーム"
        description="ほかの人と対戦したり、対局を観戦したりできます。"
      >
        <AppButton
          size="compact"
          className="px-[9px] text-[13px]"
          appearance="quiet"
          type="button"
          onPress={onRefresh}
          isDisabled={loading || moreLoading}
          isPending={pendingSource === "refresh"}
        >
          <AppIcon name="refresh" />
          更新
        </AppButton>
      </AppSectionHeading>
      {error && (
        <p
          className="mb-4 py-[13px] px-4 border border-solid border-[#efd9d2] rounded-[11px] text-[#98472f] bg-[#fdf4f0] text-[13px] wrap-anywhere"
          role="status"
        >
          {error}「更新」からもう一度お試しください。
        </p>
      )}
      {loading && pendingSource === "refresh" && (
        <p className="mb-3 text-muted text-[13px]" role="status">
          公開ルームを読み込んでいます…
        </p>
      )}
      {rooms.length === 0 && isInitialLoading && !pendingSource && (
        <AppCard
          className="flex flex-col items-center justify-center gap-2 min-h-[140px] py-[22px] px-5 border-dashed border-[#d7e1da] rounded-[18px] bg-[#ffffffdf] text-center shadow-none [&_h3]:text-[15px] [&_p]:text-muted [&_p]:text-[13px] [@media(max-width:650px)]:py-5 [@media(max-width:650px)]:px-[18px]"
          role="status"
        >
          <p>公開ルームを読み込んでいます…</p>
        </AppCard>
      )}
      {rooms.length === 0 && !isInitialLoading && !error && (
        <AppCard className="flex flex-col items-center justify-center gap-2 min-h-[140px] py-[22px] px-5 border-dashed border-[#d7e1da] rounded-[18px] bg-[#ffffffdf] text-center shadow-none [&_h3]:text-[15px] [&_p]:text-muted [&_p]:text-[13px] [@media(max-width:650px)]:py-5 [@media(max-width:650px)]:px-[18px]">
          <span className="grid place-items-center shrink-0 size-11 rounded-[13px] text-brand-hover bg-surface-muted">
            <AppIcon name="users" />
          </span>
          <h3>公開ルームはまだありません</h3>
          <p>CPUとすぐ遊ぶか、ルームを作って友達を招待できます。</p>
        </AppCard>
      )}
      {rooms.length > 0 && (
        <>
          <div className="[@media(max-width:767px)]:max-h-[400px] [@media(max-width:767px)]:overflow-y-auto">
            <ul
              aria-label="公開ルーム一覧"
              className="m-0 grid grid-cols-[repeat(auto-fill,minmax(min(100%,440px),1fr))] gap-3.5 p-0 list-none"
            >
              {rooms.map((room) => (
                <li key={room.id} className="min-w-0">
                  <LobbyRoomCard room={room} showGame={false}>
                    {room.status === "waiting" && room.openSeats > 0 && (
                      <AppButton
                        size="compact"
                        type="button"
                        aria-label={`ルーム ${room.id} に参加`}
                        onPress={() => onJoin(room.id, room.cpuCount === 0)}
                      >
                        参加
                      </AppButton>
                    )}
                    <AppButton
                      size="compact"
                      appearance="secondary"
                      type="button"
                      aria-label={`ルーム ${room.id} を観戦`}
                      isPending={pendingWatchRoomId === room.id}
                      onPress={() => onWatch(room.id)}
                    >
                      観戦
                    </AppButton>
                  </LobbyRoomCard>
                </li>
              ))}
            </ul>
          </div>
          <LobbyRoomLegend />
        </>
      )}
      {nextCursor !== null && (
        <div className="mt-[14px] text-center">
          <AppButton
            size="compact"
            appearance="secondary"
            type="button"
            onPress={onLoadMore}
            isDisabled={loading || moreLoading}
            isPending={moreLoading}
          >
            もっと見る
          </AppButton>
        </div>
      )}
    </section>
  );
}
