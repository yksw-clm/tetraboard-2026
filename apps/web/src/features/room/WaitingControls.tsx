import { type CpuLevel, type Room, type RoomMembership, type RoomMode } from "@tetraboard/protocol";

type Props = {
  room: Room;
  membership: RoomMembership | null;
  authenticated: boolean;
  connection: string;
  canManageSettings: boolean;
  pendingReady: boolean | null;
  pendingGameAction: boolean;
  leaving: boolean;
  newCpuLevel: CpuLevel;
  onLeave: () => void;
  onReady: () => void;
  onStart: () => void;
  onModeChange: (mode: RoomMode) => void;
  onCpuLevelChange: (level: CpuLevel) => void;
  onCpuAdd: (level: CpuLevel) => void;
};

export function WaitingControls({
  room,
  membership,
  authenticated,
  connection,
  canManageSettings,
  pendingReady,
  pendingGameAction,
  leaving,
  newCpuLevel,
  onLeave,
  onReady,
  onStart,
  onModeChange,
  onCpuLevelChange,
  onCpuAdd,
}: Props) {
  const self = room.players.find((player) => player.id === membership?.playerId);

  return (
    <>
      {room.status === "waiting" && membership?.role === "host" ? (
        <>
          <label htmlFor="room-mode">対局モード</label>
          <select
            id="room-mode"
            value={room.settings.mode}
            disabled={!canManageSettings}
            onChange={(event) => onModeChange(event.target.value as RoomMode)}
          >
            <option value="singles">シングルス</option>
            <option value="doubles">ダブルス</option>
          </select>
        </>
      ) : (
        <p>対局モード：{room.settings.mode === "singles" ? "シングルス" : "ダブルス"}</p>
      )}
      {membership !== null && (
        <button type="button" disabled={leaving} onClick={onLeave}>
          退室
        </button>
      )}
      {membership !== null && self !== undefined && room.status === "waiting" && (
        <button
          type="button"
          onClick={onReady}
          disabled={!authenticated || connection !== "接続済み" || pendingReady !== null}
        >
          {self.ready ? "準備取消" : "準備完了"}
        </button>
      )}
      {room.status === "waiting" && membership?.role === "host" && (
        <button
          type="button"
          onClick={onStart}
          disabled={
            !authenticated ||
            connection !== "接続済み" ||
            room.players.length !== 4 ||
            room.players.some((player) => !player.ready || player.reconnectDeadline !== null) ||
            pendingGameAction
          }
        >
          対局開始
        </button>
      )}
      {room.status === "waiting" && membership?.role === "host" && (
        <div>
          <label htmlFor="new-cpu-level">追加するCPUのレベル</label>
          <select
            id="new-cpu-level"
            value={newCpuLevel}
            onChange={(event) => onCpuLevelChange(Number(event.target.value) as CpuLevel)}
            disabled={!canManageSettings}
          >
            <option value={1}>レベル1（よわい）</option>
            <option value={2}>レベル2（ふつう）</option>
          </select>
          <button
            type="button"
            disabled={!canManageSettings || room.players.length >= 4}
            onClick={() => onCpuAdd(newCpuLevel)}
          >
            CPUを追加
          </button>
        </div>
      )}
    </>
  );
}
