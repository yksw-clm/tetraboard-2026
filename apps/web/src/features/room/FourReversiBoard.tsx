import { type LastRound, type Room } from "@tetraboard/protocol";
import { type Position } from "@tetraboard/four-reversi";
import { colorNames } from "./roomPresentation";

const columns = "ABCDEFGH";
type DisplayGame = Exclude<Room["game"] | LastRound["game"], null>;

type Props = {
  room: Room;
  game: DisplayGame;
  legalMoves: Position[];
  canPlay: boolean;
  pendingGameAction: boolean;
  onResign: () => void;
  onPlaceStone: (position: Position) => void;
};

export function FourReversiBoard({
  room,
  game,
  legalMoves,
  canPlay,
  pendingGameAction,
  onResign,
  onPlaceStone,
}: Props) {
  return (
    <>
      <p>
        {room.status === "waiting"
          ? "前局は終了しました。再戦待機中です。"
          : `手番：${room.game.turn ? colorNames[room.game.turn] : ""}`}
      </p>
      {canPlay && (
        <button type="button" onClick={onResign} disabled={pendingGameAction}>
          投了
        </button>
      )}
      <p>着手数：{game.moveNumber}</p>
      {game.consecutivePasses.length > 0 && (
        <p>
          自動パス：
          {game.consecutivePasses.map((color) => colorNames[color]).join(" → ")}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th></th>
            {[...columns].map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {game.board.map((row, y) => (
            <tr key={y}>
              <th>{y + 1}</th>
              {row.map((cell, x) => {
                const legal = legalMoves.some((move) => move.x === x && move.y === y);
                return (
                  <td key={x}>
                    <button
                      type="button"
                      aria-label={`${columns[x]}${y + 1}: ${cell === null ? "空き" : colorNames[cell]}`}
                      disabled={!canPlay || !legal}
                      onClick={() => onPlaceStone({ x, y })}
                    >
                      {cell === null ? (legal && canPlay ? "＋" : "・") : colorNames[cell]}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
