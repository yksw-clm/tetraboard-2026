import { type CpuLevel, type Room, type RoomMembership } from "@tetraboard/protocol";
import { colorNames, playerClockText } from "./roomPresentation";

type Props = {
  room: Room;
  membership: RoomMembership | null;
  serverNowMs: number;
  canManageSettings: boolean;
  onCpuLevelChange: (playerId: string, level: CpuLevel) => void;
  onCpuRemove: (playerId: string) => void;
};

export function PlayerList({
  room,
  membership,
  serverNowMs,
  canManageSettings,
  onCpuLevelChange,
  onCpuRemove,
}: Props) {
  return (
    <>
      <h2>プレイヤー</h2>
      <ul>
        {room.players.map((player) => (
          <li key={player.id}>
            {membership?.playerId === player.id && "[あなた] "}
            {player.name} ({player.id}) {player.kind === "cpu" && ` CPU レベル${player.level}`}{" "}
            {room.status === "waiting" && player.ready && "✅"}
            {player.color !== null && ` ${colorNames[player.color]}`}
            {player.reconnectDeadline !== null && " 復帰待ち"}
            {room.status !== "waiting" &&
              player.color !== null &&
              room.game.eliminatedColors.includes(player.color) &&
              " 脱落"}
            {player.color !== null &&
              playerClockText(room, player.color, serverNowMs) !== null &&
              ` ${playerClockText(room, player.color, serverNowMs)}`}
            {room.status === "waiting" && membership?.role === "host" && player.kind === "cpu" && (
              <>
                <select
                  aria-label={`${player.name}のレベル`}
                  value={player.level}
                  disabled={!canManageSettings}
                  onChange={(event) =>
                    onCpuLevelChange(player.id, Number(event.target.value) as CpuLevel)
                  }
                >
                  <option value={1}>レベル1</option>
                  <option value={2}>レベル2</option>
                </select>
                <button
                  type="button"
                  disabled={!canManageSettings}
                  onClick={() => onCpuRemove(player.id)}
                >
                  {player.name}を削除
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
