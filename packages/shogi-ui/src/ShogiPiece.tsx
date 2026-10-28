import type { HandPieceKind, PieceKind } from "./shogiUiTypes";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ShogiPieceDirection } from "./shogiBoardPresentation";
import { shogiImageStore, shogiPieceImage } from "./shogiPieceImages";
const rotationClasses: Record<ShogiPieceDirection, string> = {
  up: "",
  down: "",
  right: "rotate-90",
  left: "-rotate-90",
};
const fallbackRotationClasses: Record<ShogiPieceDirection, string> = {
  ...rotationClasses,
  down: "rotate-180",
};
export function ShogiPiece({
  kind,
  promoted = false,
  deadKing = false,
  direction,
  royalKing = false,
}: {
  kind: PieceKind | HandPieceKind;
  promoted?: boolean;
  deadKing?: boolean;
  direction: ShogiPieceDirection;
  royalKing?: boolean;
}) {
  const { src, name } = shogiPieceImage(kind, promoted, deadKing, direction, royalKing);
  return <PreparedShogiPiece key={src} src={src} name={name} direction={direction} />;
}

function PreparedShogiPiece({
  src,
  name,
  direction,
}: {
  src: string;
  name: string;
  direction: ShogiPieceDirection;
}) {
  const subscribe = useCallback(
    (listener: () => void) => shogiImageStore.subscribe(src, listener),
    [src],
  );
  const status = useSyncExternalStore(
    subscribe,
    () => shogiImageStore.getStatus(src),
    () => "idle",
  );
  const [failed, setFailed] = useState(false);
  const ready = status === "ready" && !failed;
  useEffect(() => {
    void shogiImageStore.prepare(src);
  }, [src]);
  return (
    <span
      aria-hidden="true"
      className="relative block w-[var(--shogi-piece-width)] aspect-[140/148] select-none pointer-events-none"
    >
      <img
        key={src}
        src={src}
        alt=""
        onError={() => setFailed(true)}
        draggable={false}
        aria-hidden="true"
        data-testid="shogi-piece"
        data-piece-direction={direction}
        className={`block w-[var(--shogi-piece-width)] max-w-none aspect-[140/148] object-contain select-none pointer-events-none ${rotationClasses[direction]} ${ready ? "" : "invisible"}`}
      />
      {!ready && (
        <span
          className={`absolute inset-0 box-border grid place-items-center rounded-[2px] border border-solid border-[#9c6f14] bg-[#f8e0a1] text-[#543618] font-bold leading-none text-[length:calc(var(--shogi-piece-width)*0.36)] [writing-mode:vertical-rl] ${fallbackRotationClasses[direction]}`}
        >
          {name}
        </span>
      )}
    </span>
  );
}
