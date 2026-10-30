import type { FourShogiAction, Side } from "./shogiUiTypes";
import {
  shogiDisplayPosition,
  shogiPieceNames,
  type ShogiBoardView,
} from "./shogiBoardPresentation";

export type ShogiBestMove = Readonly<{ action: FourShogiAction; label: string }>;

/** 操作gridと同じ9×9の座標で、表示専用の推奨手を重ねます。 */
export function ShogiBestMoveOverlay({
  move,
  game,
  viewerSide,
}: {
  move: ShogiBestMove;
  game: ShogiBoardView;
  viewerSide: Side;
}) {
  const { action } = move;
  const to = shogiDisplayPosition(action.to, viewerSide);
  const end = { x: to.x + 0.5, y: to.y + 0.5 };
  const from = action.type === "movePiece" ? shogiDisplayPosition(action.from, viewerSide) : null;
  const start = from ? { x: from.x + 0.5, y: from.y + 0.5 } : end;
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const dx = length ? (end.x - start.x) / length : 0;
  const dy = length ? (end.y - start.y) / length : 0;
  const piece = action.type === "movePiece" ? game.board[action.from.y][action.from.x] : null;
  const promotion =
    action.type === "movePiece"
      ? action.promote
        ? "成"
        : piece && !piece.promoted && piece.kind !== "king" && piece.kind !== "gold"
          ? "不成"
          : null
      : null;
  const badge = {
    x: Math.max(0.5, Math.min(8.5, (start.x + end.x) / 2 - dy * 0.35)),
    y: Math.max(0.5, Math.min(8.5, (start.y + end.y) / 2 + dx * 0.35)),
  };
  return (
    <svg
      data-testid="shogi-best-move"
      role="img"
      aria-label={move.label}
      viewBox="0 0 9 9"
      preserveAspectRatio="none"
      focusable="false"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    >
      {action.type === "movePiece" ? (
        <g fill="#2563eb" stroke="#2563eb" opacity="0.8">
          <line
            x1={start.x}
            y1={start.y}
            x2={end.x}
            y2={end.y}
            strokeWidth="0.16"
            strokeLinecap="round"
          />
          <polygon
            stroke="none"
            points={`${end.x},${end.y} ${end.x - dx * 0.4 - dy * 0.24},${end.y - dy * 0.4 + dx * 0.24} ${end.x - dx * 0.4 + dy * 0.24},${end.y - dy * 0.4 - dx * 0.24}`}
          />
        </g>
      ) : (
        <g>
          <circle
            cx={end.x}
            cy={end.y}
            r="0.39"
            fill="#eff6ff"
            fillOpacity="0.85"
            stroke="#2563eb"
            strokeWidth="0.08"
          />
          <text
            x={end.x}
            y={end.y + 0.1}
            textAnchor="middle"
            fontSize="0.28"
            fontWeight="700"
            fill="#1747a6"
          >
            {shogiPieceNames[action.pieceKind]}打
          </text>
        </g>
      )}
      {promotion && (
        <g>
          <rect
            x={badge.x - 0.4}
            y={badge.y - 0.2}
            width="0.8"
            height="0.4"
            rx="0.1"
            fill="#eff6ff"
            fillOpacity="0.92"
          />
          <text
            x={badge.x}
            y={badge.y + 0.1}
            textAnchor="middle"
            fontSize="0.28"
            fontWeight="700"
            fill="#1747a6"
          >
            {promotion}
          </text>
        </g>
      )}
    </svg>
  );
}
