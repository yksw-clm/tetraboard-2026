import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppSectionHeading } from "../../shared/ui/AppSectionHeading";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton } from "../../shared/ui/AppButton";
import { Chip } from "@heroui/react";
import { type RoomPublicMetadata } from "@tetraboard/protocol";
import { AppIcon } from "../../shared/ui/AppIcon";

type Props = {
  rooms: RoomPublicMetadata[];
  nextCursor: string | null;
  error: string | null;
  loading: boolean;
  moreLoading: boolean;
  onRefresh: () => void;
  onLoadMore: () => void;
  onJoin: (roomId: string) => void;
  onWatch: (roomId: string) => void;
};

export function LobbyList({
  rooms,
  nextCursor,
  error,
  loading,
  moreLoading,
  onRefresh,
  onLoadMore,
  onJoin,
  onWatch,
}: Props) {
  return (
    <section aria-labelledby="public-rooms-title">
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
      {rooms.length === 0 && loading && (
        <AppCard
          className="flex flex-col items-center justify-center gap-2 min-h-[140px] py-[22px] px-5 border-dashed border-[#d7e1da] rounded-[18px] bg-[#ffffffdf] text-center shadow-none [&_h3]:text-[15px] [&_p]:text-muted [&_p]:text-[13px] [@media(max-width:650px)]:py-5 [@media(max-width:650px)]:px-[18px]"
          role="status"
        >
          <p>公開ルームを読み込んでいます…</p>
        </AppCard>
      )}
      {rooms.length === 0 && !loading && !error && (
        <AppCard className="flex flex-col items-center justify-center gap-2 min-h-[140px] py-[22px] px-5 border-dashed border-[#d7e1da] rounded-[18px] bg-[#ffffffdf] text-center shadow-none [&_h3]:text-[15px] [&_p]:text-muted [&_p]:text-[13px] [@media(max-width:650px)]:py-5 [@media(max-width:650px)]:px-[18px]">
          <span className="grid place-items-center shrink-0 size-11 rounded-[13px] text-brand-hover bg-[#edf6f0]">
            <AppIcon name="users" />
          </span>
          <h3>公開ルームはまだありません</h3>
          <p>CPUとすぐ遊ぶか、ルームを作って友達を招待できます。</p>
        </AppCard>
      )}
      {rooms.length > 0 && (
        <>
          <div
            className="grid grid-cols-[minmax(150px,1.5fr)_minmax(90px,0.85fr)_minmax(130px,1fr)_100px_156px] items-center gap-4 px-6 pb-[10px] text-muted text-[11px] [@media(max-width:900px)]:hidden"
            aria-hidden="true"
          >
            <span>ルーム</span>
            <span>モード</span>
            <span>参加人数</span>
            <span>状態</span>
            <span />
          </div>
          <ul className="m-0 p-0 overflow-hidden border border-solid border-line rounded-panel bg-white list-none [&>li+li>div]:border-t [&>li+li>div]:border-line [@media(max-width:900px)]:grid [@media(650px<width<=900px)]:grid-cols-2 [@media(650px<width<=900px)]:gap-[14px] [@media(max-width:900px)]:overflow-visible [@media(max-width:900px)]:border-0 [@media(max-width:900px)]:rounded-none [@media(max-width:900px)]:bg-transparent [@media(max-width:650px)]:grid-cols-1 [@media(max-width:650px)]:gap-[10px]">
            {rooms.map((room) => {
              const canJoin = room.status === "waiting" && room.openSeats > 0;
              return (
                <li key={room.id}>
                  <AppCard className="grid grid-cols-[minmax(150px,1.5fr)_minmax(90px,0.85fr)_minmax(130px,1fr)_100px_156px] items-center gap-4 py-[14px] px-6 border-0 rounded-none shadow-none [@media(max-width:900px)]:grid-cols-[minmax(0,1fr)_auto] [@media(max-width:900px)]:gap-[10px] [@media(max-width:900px)]:py-4 [@media(max-width:900px)]:px-5 [@media(max-width:900px)]:border [@media(max-width:900px)]:border-solid [@media(max-width:900px)]:border-line [@media(max-width:900px)]:rounded-panel [@media(max-width:900px)]:bg-white">
                    <div className="flex items-center min-w-0 gap-3">
                      <AppAvatar src={room.hostAvatarUrl} label={room.hostName ?? "ホストなし"} />
                      <div className="min-w-0">
                        <strong className="block text-sm wrap-anywhere">
                          {room.hostName ?? "ホストなし"}
                        </strong>
                        <span className="block text-xs text-muted tabular-nums">{room.id}</span>
                      </div>
                    </div>
                    <span className="text-ink-secondary text-[13px] [@media(max-width:900px)]:col-start-1 [@media(max-width:900px)]:row-start-2">
                      {room.mode === "singles" ? "シングルス" : "ダブルス"}
                    </span>
                    <div className="flex items-center min-w-0 gap-3 [@media(max-width:900px)]:col-start-1 [@media(max-width:900px)]:row-start-3">
                      <strong className="text-base tabular-nums whitespace-nowrap">
                        {room.humanCount + room.cpuCount}/{room.capacity}
                      </strong>
                      <span
                        className="inline-flex gap-1"
                        role="img"
                        aria-label={`人間${room.humanCount}人、CPU${room.cpuCount}人、空席${room.capacity - room.humanCount - room.cpuCount}席`}
                      >
                        {Array.from({ length: room.capacity }, (_, index) => (
                          <span
                            key={index}
                            className={`size-2 rounded-full ${index < room.humanCount ? "bg-[#34a871]" : index < room.humanCount + room.cpuCount ? "bg-[#376597]" : "bg-[#cbd3ce]"}`}
                          />
                        ))}
                      </span>
                    </div>
                    <div className="flex items-center flex-wrap gap-1 [@media(max-width:900px)]:col-start-2 [@media(max-width:900px)]:row-start-1 [@media(max-width:900px)]:justify-end">
                      <Chip
                        className={`inline-flex items-center gap-[6px] w-fit rounded-[20px] py-1 px-[10px] text-[11px] font-semibold whitespace-nowrap ${room.status === "playing" ? "text-[#806323] bg-[#fcf5e4]" : "text-[#27794f] bg-[#edf7f0]"}`}
                      >
                        <Chip.Label className="inline-flex items-center gap-[6px]">
                          <span className="size-[5px] rounded-full bg-current" />
                          {room.status === "waiting" ? "対局前" : "対局中"}
                        </Chip.Label>
                      </Chip>
                    </div>
                    <div className="flex justify-end gap-2 [@media(max-width:900px)]:col-start-2 [@media(max-width:900px)]:row-start-3">
                      {canJoin && (
                        <AppButton
                          size="compact"
                          type="button"
                          aria-label={`ルーム ${room.id} に参加`}
                          onPress={() => onJoin(room.id)}
                        >
                          参加
                        </AppButton>
                      )}
                      <AppButton
                        size="compact"
                        appearance="secondary"
                        type="button"
                        aria-label={`ルーム ${room.id} を観戦`}
                        onPress={() => onWatch(room.id)}
                      >
                        観戦
                      </AppButton>
                    </div>
                  </AppCard>
                </li>
              );
            })}
          </ul>
          <p className="mt-[10px]! text-muted text-[11px]">
            CPUを含む席数です。対局中は開始時の参加人数を表示しています。
          </p>
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
          >
            {moreLoading ? "読み込み中…" : "もっと見る"}
          </AppButton>
        </div>
      )}
    </section>
  );
}
