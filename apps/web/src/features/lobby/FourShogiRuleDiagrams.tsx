import type { ReactNode } from "react";
import type { PieceKind } from "@tetraboard/four-shogi";
import { createInitialBoard } from "@tetraboard/four-shogi/board";
import { boardImageUrl } from "@tetraboard/shogi-ui/board-image";
import { ShogiBoardSquareLines } from "@tetraboard/shogi-ui/board-lines";
import { StaticShogiPiece } from "@tetraboard/shogi-ui/piece";
import { shogiNotationSquare } from "@tetraboard/shogi-ui/notation";
import {
  shogiPieceDirection,
  shogiPieceNames,
  shogiSideNames,
  shogiSides,
} from "@tetraboard/shogi-ui/presentation";

export type RulesDiagramAssetResolver = (source: string) => string;

const { board: initialBoard } = createInitialBoard();

function DiagramBoard({
  size,
  resolveAsset,
  className = "",
  priority = "low",
  cell,
  overlay,
}: {
  size: 5 | 9;
  resolveAsset?: RulesDiagramAssetResolver;
  className?: string;
  priority?: "high" | "low";
  cell?: (x: number, y: number) => ReactNode;
  overlay?: ReactNode;
}) {
  const gridClasses = size === 9 ? "grid-cols-9 grid-rows-9" : "grid-cols-5 grid-rows-5";
  return (
    <div
      className={`relative aspect-square bg-[#cb8900] shadow-[0_8px_24px_#71531c25] ${className}`}
    >
      <img
        src={resolveAsset?.(boardImageUrl) ?? boardImageUrl}
        alt=""
        fetchPriority={priority}
        className="absolute inset-0 size-full object-cover"
      />
      <div
        className={`absolute inset-[1.3%] isolate grid [--shogi-piece-width:82%] ${gridClasses}`}
      >
        {overlay}
        {Array.from({ length: size * size }, (_, index) => {
          const x = index % size;
          const y = Math.floor(index / size);
          return (
            <div key={index} className="relative grid min-w-0 min-h-0 place-items-center">
              {cell?.(x, y)}
              <ShogiBoardSquareLines x={x} y={y} size={size} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const initialPlacement = initialBoard.flatMap((rank, y) =>
  rank.flatMap((piece, x) =>
    piece
      ? [
          {
            side: piece.side,
            text: `${shogiNotationSquare({ x, y })}に${shogiPieceNames[piece.kind]}`,
          },
        ]
      : [],
  ),
);

type DiagramProps = { resolveAsset?: RulesDiagramAssetResolver };

export function InitialPositionDiagram({ resolveAsset }: DiagramProps) {
  return (
    <div>
      <div
        role="img"
        aria-label="9×9の初期配置。下が南、左が西、上が北、右が東。各陣営の駒9枚は盤の中央を向きます。"
        className="mx-auto grid w-full max-w-[348px] grid-cols-[1.5rem_minmax(0,1fr)_1.5rem] items-center text-center text-sm font-bold"
      >
        <span className="col-start-2 row-start-1 pb-1">北</span>
        <span className="col-start-1 row-start-2">西</span>
        <DiagramBoard
          size={9}
          priority="high"
          className="col-start-2 row-start-2"
          resolveAsset={resolveAsset}
          cell={(x, y) => {
            const piece = initialBoard[y]![x];
            if (!piece) return null;
            return (
              <div
                data-square={`${x},${y}`}
                data-side={piece.side}
                data-piece={piece.kind}
                className="grid size-full place-items-center"
              >
                <StaticShogiPiece
                  kind={piece.kind}
                  promoted={piece.promoted}
                  direction={shogiPieceDirection(piece.side, "south")}
                  resolveAsset={resolveAsset}
                />
              </div>
            );
          }}
        />
        <span className="col-start-3 row-start-2">東</span>
        <span className="col-start-2 row-start-3 pt-1">南</span>
      </div>
      <dl className="sr-only" aria-label="初期配置の駒と位置">
        {shogiSides.map((side) => (
          <div key={side}>
            <dt>{shogiSideNames[side]}</dt>
            <dd>
              {initialPlacement
                .filter((piece) => piece.side === side)
                .map((piece) => piece.text)
                .join("、")}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const cellSize = 32;
const diagonals = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;
const orthogonals = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
] as const;
const moves: {
  name: string;
  kind: PieceKind;
  description: string;
  steps: ReadonlyArray<readonly [number, number]>;
  slides?: boolean;
  promoted?: boolean;
}[] = [
  {
    name: "王",
    kind: "king",
    description: "縦・横・斜めに1マス",
    steps: [...orthogonals, ...diagonals],
  },
  { name: "飛車", kind: "rook", description: "縦・横に進めるだけ", steps: [], slides: true },
  {
    name: "龍",
    kind: "rook",
    promoted: true,
    description: "縦・横に進めるだけ、斜めに1マス",
    steps: diagonals,
    slides: true,
  },
  {
    name: "金",
    kind: "gold",
    description: "前・後ろ・左右・斜め前に1マス",
    steps: [...orthogonals, [-1, -1], [1, -1]],
  },
  {
    name: "銀",
    kind: "silver",
    description: "前・斜め前・斜め後ろに1マス",
    steps: [[0, -1], ...diagonals],
  },
  { name: "歩", kind: "pawn", description: "前に1マス", steps: [[0, -1]] },
];

export function PieceMovesDiagrams({ resolveAsset }: DiagramProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {moves.map(({ name, kind, promoted, description, steps, slides }) => (
        <figure
          key={name}
          className="m-0 rounded-lg border border-solid border-lobby-footer-line bg-white px-2 py-3 text-center"
        >
          <figcaption className="mb-2 font-bold">{name}</figcaption>
          <div
            role="img"
            aria-label={`${name}は${description}移動できます。`}
            className="mx-auto w-full max-w-36"
          >
            <DiagramBoard
              size={5}
              resolveAsset={resolveAsset}
              cell={(x, y) =>
                x === 2 && y === 2 ? (
                  <StaticShogiPiece
                    kind={kind}
                    promoted={promoted}
                    direction="up"
                    resolveAsset={resolveAsset}
                  />
                ) : null
              }
              overlay={
                <svg
                  aria-hidden="true"
                  viewBox="0 0 160 160"
                  className="pointer-events-none absolute inset-0 z-[3] size-full"
                >
                  <g transform="translate(80 80)" fill="#285f4b" stroke="#285f4b">
                    {steps.map(([dx, dy]) => (
                      <circle key={`${dx},${dy}`} cx={dx * cellSize} cy={dy * cellSize} r="5" />
                    ))}
                    {slides &&
                      [0, 90, 180, 270].map((angle) => (
                        <path
                          key={angle}
                          transform={`rotate(${angle})`}
                          d="M0 -17V-70m-6 7 6-7 6 7"
                          fill="none"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      ))}
                  </g>
                </svg>
              }
            />
          </div>
        </figure>
      ))}
    </div>
  );
}

export function PromotionZoneDiagram({ resolveAsset }: DiagramProps) {
  return (
    <div
      role="img"
      aria-label="南から見た成れる区域。盤の向こう側の3段すべてが成れる区域です。"
      className="mx-auto w-full max-w-[288px] text-center text-sm font-bold"
    >
      <DiagramBoard
        size={9}
        resolveAsset={resolveAsset}
        overlay={
          <>
            <div className="absolute inset-x-0 top-0 h-1/3 bg-[#ffeb8980]" />
            <div className="absolute inset-x-0 top-0 z-[3] grid h-1/3 place-items-center">
              <span className="rounded bg-[#fff7dd] px-3 py-1">成れる区域</span>
            </div>
          </>
        }
      />
      <span className="block pt-1">南（自分）</span>
    </div>
  );
}
