export function ShogiBoardSquareLines({ x, y, size = 9 }: { x: number; y: number; size?: number }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={`absolute inset-0 z-[1] pointer-events-none border-solid border-[#3b260c] border-t border-l ${x === size - 1 ? "border-r" : "border-r-0"} ${y === size - 1 ? "border-b" : "border-b-0"}`}
      />
      {size === 9 && (x === 3 || x === 6) && (y === 3 || y === 6) && (
        <span
          aria-hidden="true"
          className="absolute top-0 left-0 z-[2] size-[clamp(3px,14%,8px)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#3b260c] pointer-events-none"
        />
      )}
    </>
  );
}
