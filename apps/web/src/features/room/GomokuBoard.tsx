import type { FourGomokuState } from "@tetraboard/four-gomoku";
import { boardPositionForDisplay } from "./boardRotation";
import { useId } from "react";
import type { GomokuState, Position } from "@tetraboard/gomoku";
import type { QuarterTurn } from "./boardRotation";

export function GomokuBoard({
  game,
  rotation = 0,
  canPlay,
  onPlaceStone,
  label = "五目並べの盤面",
}: {
  game: GomokuState | FourGomokuState;
  rotation?: QuarterTurn;
  canPlay: boolean;
  onPlaceStone: (position: Position) => void;
  label?: string;
  legalMoves?: Position[];
}) {
  const id = useId();
  const display = (x: number, y: number) =>
    boardPositionForDisplay({ x, y }, 15, ((4 - rotation) % 4) as QuarterTurn);
  const original = (x: number, y: number) => boardPositionForDisplay({ x, y }, 15, rotation);
  const winning = new Set(
    ("winningLines" in game ? game.winningLines : game.result?.winningLines)
      ?.flat()
      .map((p) => `${p.x},${p.y}`) ?? [],
  );
  return (
    <div
      role="group"
      aria-label={label}
      className="relative aspect-square w-full overflow-hidden rounded-md bg-[#e7c48c] shadow-md [grid-area:board]"
    >
      <svg viewBox="0 0 17 17" className="absolute inset-0 size-full" aria-hidden="true">
        <defs>
          <radialGradient id={`${id}-black`} cx="30%" cy="25%">
            <stop stopColor="#555" />
            <stop offset="1" stopColor="#171717" />
          </radialGradient>
          <radialGradient id={`${id}-white`} cx="30%" cy="25%">
            <stop stopColor="#fff" />
            <stop offset="1" stopColor="#e5e5e5" />
          </radialGradient>
          <radialGradient id={`${id}-red`} cx="30%" cy="25%">
            <stop stopColor="#ff7777" />
            <stop offset="1" stopColor="#b91c1c" />
          </radialGradient>
          <radialGradient id={`${id}-blue`} cx="30%" cy="25%">
            <stop stopColor="#72b3ff" />
            <stop offset="1" stopColor="#1d4ed8" />
          </radialGradient>
        </defs>
        {Array.from({ length: 15 }, (_, i) => (
          <g key={i}>
            <path
              d={`M 1.5 ${i + 1.5} H 15.5 M ${i + 1.5} 1.5 V 15.5`}
              stroke="#72502e"
              strokeWidth="0.025"
            />
            <text x={i + 1.5} y="0.65" textAnchor="middle" fontSize="0.48" fill="#4a321d">
              {rotation % 2 === 0 ? "ABCDEFGHIJKLMNO"[original(i, 0).x] : original(i, 0).y + 1}
            </text>
            <text x="0.55" y={i + 1.67} textAnchor="middle" fontSize="0.48" fill="#4a321d">
              {rotation % 2 === 0 ? original(0, i).y + 1 : "ABCDEFGHIJKLMNO"[original(0, i).x]}
            </text>
          </g>
        ))}
        {[
          [3, 3],
          [11, 3],
          [7, 7],
          [3, 11],
          [11, 11],
        ].map(([x, y]) => (
          <circle key={`${x},${y}`} cx={x + 1.5} cy={y + 1.5} r="0.08" fill="#72502e" />
        ))}
        {game.board.flatMap((row, y) =>
          row.map(
            (color, x) =>
              color && (
                <g key={`${x},${y}`}>
                  <circle
                    cx={display(x, y).x + 1.5}
                    cy={display(x, y).y + 1.5}
                    r="0.43"
                    fill={`url(#${id}-${color})`}
                    stroke={
                      winning.has(`${x},${y}`)
                        ? "#7c3aed"
                        : color === "white"
                          ? "#a89880"
                          : "#171717"
                    }
                    strokeWidth={winning.has(`${x},${y}`) ? "0.095" : "0.025"}
                  />
                  {game.lastMove?.x === x && game.lastMove.y === y && (
                    <circle
                      cx={display(x, y).x + 1.5}
                      cy={display(x, y).y + 1.5}
                      r="0.10"
                      fill="#f97316"
                    />
                  )}
                </g>
              ),
          ),
        )}
      </svg>
      {Array.from({ length: 15 }, (_, vy) =>
        Array.from({ length: 15 }, (_, vx) => {
          const { x, y } = original(vx, vy);
          const cell = game.board[y][x];
          return (
            <button
              key={`${x},${y}`}
              type="button"
              aria-label={`${"ABCDEFGHIJKLMNO"[x]}${y + 1}${cell ? ` ${{ black: "黒", white: "白", red: "赤", blue: "青" }[cell]}` : " 空点"}`}
              disabled={!canPlay || cell !== null}
              onClick={() => onPlaceStone({ x, y })}
              className="absolute m-0 cursor-pointer touch-manipulation border-0 bg-transparent p-0 enabled:hover:bg-violet-500/20 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default"
              style={{
                left: `${((vx + 1) / 17) * 100}%`,
                top: `${((vy + 1) / 17) * 100}%`,
                width: `${100 / 17}%`,
                height: `${100 / 17}%`,
              }}
            />
          );
        }),
      )}
    </div>
  );
}
