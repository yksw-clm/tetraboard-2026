const stoneClasses = {
  black: "preview-stone-black",
  white: "preview-stone-white",
  red: "preview-stone-red",
  blue: "preview-stone-blue",
} as const;
const fourPlayerStones: Record<number, keyof typeof stoneClasses> = {
  19: "black",
  28: "black",
  35: "white",
  44: "white",
  27: "red",
  34: "red",
  29: "blue",
  36: "blue",
};
const twoPlayerStones: Record<number, keyof typeof stoneClasses> = {
  27: "white",
  28: "black",
  35: "black",
  36: "white",
};

export function ReversiLobbyBoardPreview({
  fourPlayer,
  compact = false,
}: {
  fourPlayer: boolean;
  compact?: boolean;
}) {
  const stones = fourPlayer ? fourPlayerStones : twoPlayerStones;
  return (
    <div
      aria-hidden="true"
      data-testid="lobby-board-preview"
      className={`grid shrink-0 grid-cols-8 grid-rows-8 aspect-square gap-px border border-solid border-[#316a4d] rounded-lg bg-[#326a4e] shadow-[4px_7px_12px_#32694a22] -rotate-7 ${compact ? "w-16 p-[3px]" : "w-[88px] p-[5px] [@media(max-width:767px)]:w-[56px] [@media(max-width:767px)]:p-[3px]"}`}
    >
      {Array.from({ length: 64 }, (_, index) => (
        <span className="relative min-w-0 min-h-0 bg-[#4d976c] even:bg-[#529c71]" key={index}>
          {stones[index] && (
            <span
              className={`absolute inset-[8%] rounded-full border border-solid border-[#00000018] shadow-[1px_2px_3px_#122d3150] ${stoneClasses[stones[index]!]}`}
            />
          )}
        </span>
      ))}
    </div>
  );
}
