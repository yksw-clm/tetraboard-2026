import { Button, Card, Chip } from "@heroui/react";
import { type RoomPublicMetadata } from "@tetraboard/protocol";
import { LobbyIcon } from "./LobbyIcon";

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
    <section className="lobby-public" aria-labelledby="public-rooms-title">
      <div className="lobby-section-heading">
        <div>
          <h2 id="public-rooms-title">公開ルーム</h2>
          <p>ほかの人と対戦したり、対局を観戦したりできます。</p>
        </div>
        <Button
          className="lobby-button lobby-button-quiet"
          variant="ghost"
          type="button"
          onPress={onRefresh}
          isDisabled={loading || moreLoading}
        >
          <LobbyIcon name="refresh" />
          更新
        </Button>
      </div>
      {error && (
        <p className="lobby-error" role="status">
          {error}「更新」からもう一度お試しください。
        </p>
      )}
      {rooms.length === 0 && loading && (
        <Card className="lobby-empty" role="status">
          <p>公開ルームを読み込んでいます…</p>
        </Card>
      )}
      {rooms.length === 0 && !loading && !error && (
        <Card className="lobby-empty">
          <span className="lobby-empty-icon">
            <LobbyIcon name="users" />
          </span>
          <h3>公開ルームはまだありません</h3>
          <p>CPUとすぐ遊ぶか、ルームを作って友達を招待できます。</p>
        </Card>
      )}
      {rooms.length > 0 && (
        <>
          <div className="lobby-list-labels" aria-hidden="true">
            <span>ルーム</span>
            <span>モード</span>
            <span>参加人数</span>
            <span>状態</span>
            <span />
          </div>
          <ul className="lobby-room-list">
            {rooms.map((room) => {
              const canJoin = room.status === "waiting" && room.openSeats > 0;
              return (
                <li key={room.id}>
                  <Card className="lobby-room">
                    <div className="lobby-room-identity">
                      <strong>
                        <span className="lobby-room-hash">#</span>
                        {room.id}
                      </strong>
                      <span>ホスト：{room.hostName ?? "なし"}</span>
                    </div>
                    <span className="lobby-room-mode">
                      {room.mode === "singles" ? "シングルス" : "ダブルス"}
                    </span>
                    <div className="lobby-room-occupancy">
                      <strong>
                        {room.humanCount + room.cpuCount}
                        <span> / {room.capacity}席</span>
                      </strong>
                      <span>
                        人間{room.humanCount}人・CPU{room.cpuCount}人
                      </span>
                    </div>
                    <div className="lobby-room-state">
                      <Chip
                        className={`lobby-badge ${room.status === "playing" ? "lobby-badge-playing" : "lobby-badge-waiting"}`}
                      >
                        <Chip.Label>
                          <span className="lobby-status-dot" />
                          {room.status === "waiting" ? "対局前" : "対局中"}
                        </Chip.Label>
                      </Chip>
                      {room.status === "waiting" && !canJoin && (
                        <span className="lobby-room-full">満室</span>
                      )}
                    </div>
                    <div className="lobby-room-actions">
                      {canJoin && (
                        <Button
                          className="lobby-button lobby-button-primary"
                          type="button"
                          aria-label={`ルーム ${room.id} に参加`}
                          onPress={() => onJoin(room.id)}
                        >
                          参加
                        </Button>
                      )}
                      <Button
                        className="lobby-button lobby-button-outline"
                        variant="secondary"
                        type="button"
                        aria-label={`ルーム ${room.id} を観戦`}
                        onPress={() => onWatch(room.id)}
                      >
                        観戦
                      </Button>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
          <p className="lobby-list-note">
            CPUを含む席数です。対局中は開始時の参加人数を表示しています。
          </p>
        </>
      )}
      {nextCursor !== null && (
        <div className="lobby-load-more">
          <Button
            className="lobby-button lobby-button-outline"
            variant="secondary"
            type="button"
            onPress={onLoadMore}
            isDisabled={loading || moreLoading}
          >
            {moreLoading ? "読み込み中…" : "もっと見る"}
          </Button>
        </div>
      )}
    </section>
  );
}
