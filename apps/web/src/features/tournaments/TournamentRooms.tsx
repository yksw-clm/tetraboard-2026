import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppIcon } from "../../shared/ui/AppIcon";
import { LobbyRoomCard } from "../lobby/LobbyRoomCard";
import { useGeneralLobbyRooms } from "../lobby/useGeneralLobbyRooms";

export function TournamentRooms({ tournamentId }: { tournamentId: number }) {
  const page = useGeneralLobbyRooms("four-shogi");
  const rooms = page.rooms.filter(
    (room) => room.tournamentId === tournamentId && room.status === "playing",
  );
  const empty = page.loaded && rooms.length === 0 && (!page.error || page.hasData);
  return (
    <section aria-labelledby="tournament-rooms-title" className="min-w-0">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="tournament-rooms-title" className="text-xl font-bold">
          進行中の部屋
        </h2>
        <AppButton
          appearance="quiet"
          size="compact"
          aria-label="進行中の部屋を更新"
          isDisabled={page.loading}
          isPending={page.pendingSource === "refresh"}
          onPress={() => void page.refresh()}
        >
          <AppIcon name="refresh" />
          更新
        </AppButton>
      </div>
      {page.error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {page.error}
          <AppButton
            appearance="quiet"
            size="compact"
            isDisabled={page.loading}
            isPending={page.pendingSource === "retry"}
            onPress={() => void page.refresh("retry")}
          >
            再試行
          </AppButton>
        </p>
      )}
      {!page.loaded && (
        <p role="status" className="py-5 text-sm text-muted">
          進行中の部屋を読み込んでいます…
        </p>
      )}
      {rooms.length > 0 && (
        <ul
          aria-label="進行中の部屋一覧"
          className="m-0 grid list-none grid-cols-2 gap-3 p-0 [@media(max-width:767px)]:grid-cols-1"
        >
          {rooms.map((room) => (
            <li key={`${room.id}:${room.instanceId}`} className="min-w-0">
              <LobbyRoomCard room={room}>
                <AppButtonLink
                  size="compact"
                  appearance="secondary"
                  className="min-h-11 px-3 text-xs"
                  aria-label={`ルーム ${room.id} を観戦`}
                  to={`/rooms/${room.id}?invite=${room.instanceId}&watch=1`}
                >
                  <AppIcon name="eye" className="size-4" />
                  観戦
                </AppButtonLink>
              </LobbyRoomCard>
            </li>
          ))}
        </ul>
      )}
      {empty && (
        <AppCard className="items-center justify-center p-5 text-center text-sm text-muted">
          進行中の部屋はありません。
        </AppCard>
      )}
    </section>
  );
}
