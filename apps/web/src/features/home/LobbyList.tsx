import { type RoomPublicMetadata } from "@tetraboard/protocol";

type Props = {
  rooms: RoomPublicMetadata[];
  nextCursor: string | null;
  error: string | null;
  loading: boolean;
  moreLoading: boolean;
  isSubmitting: boolean;
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
  isSubmitting,
  onRefresh,
  onLoadMore,
  onJoin,
  onWatch,
}: Props) {
  return (
    <section aria-label="公開ロビー">
      <h2>公開ロビー</h2>
      <button type="button" onClick={onRefresh} disabled={loading}>
        更新
      </button>
      {error && <p role="status">{error}</p>}
      {rooms.length === 0 && !loading && !error && <p>ルームはありません。</p>}
      <ul>
        {rooms.map((room) => (
          <li key={room.id}>
            <span>
              {room.id} / 四人リバーシ / {room.mode === "singles" ? "シングルス" : "ダブルス"} /{" "}
              {room.status} / 持ち時間{room.timeControl.mainTimeMs / 60_000}分＋1手
              {room.timeControl.byoyomiMs / 1000}秒 / ホスト：{room.hostName ?? "なし"} / 人間
              {room.humanCount}人・CPU{room.cpuCount}体 / 空席{room.openSeats}/{room.capacity}
            </span>{" "}
            {room.status === "waiting" && room.openSeats > 0 && (
              <button type="button" disabled={isSubmitting} onClick={() => onJoin(room.id)}>
                入室
              </button>
            )}{" "}
            <button type="button" onClick={() => onWatch(room.id)}>
              観戦
            </button>
          </li>
        ))}
      </ul>
      {nextCursor !== null && (
        <button type="button" onClick={onLoadMore} disabled={moreLoading}>
          もっと見る
        </button>
      )}
    </section>
  );
}
