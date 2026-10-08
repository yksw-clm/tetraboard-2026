import type { BadgeId, BadgeTier, GameId } from "@tetraboard/protocol";

// Coordinates use the complete transparent canvas, not the medal's visible bounds.
const counterPlaques: Record<
  GameId,
  Partial<Record<BadgeId, { x: number; y: number; width: number }>>
> = {
  "four-reversi": { games: { x: 50, y: 70, width: 51 }, wins: { x: 50, y: 70, width: 51 } },
  "four-shogi": {
    games: { x: 50, y: 70, width: 52 },
    wins: { x: 50, y: 69, width: 52 },
    knockouts: { x: 50, y: 70, width: 52 },
    "perfect-wins": { x: 50, y: 70, width: 52 },
  },
};

export function BadgeImage({
  game,
  id,
  tier,
  value,
  size,
}: {
  game: GameId;
  id: BadgeId;
  tier: BadgeTier;
  value: number;
  size: number;
}) {
  const plaque = counterPlaques[game][id];
  const digits = String(value);
  return (
    <span
      aria-hidden="true"
      className="relative inline-block shrink-0 align-middle"
      style={{ width: size, maxWidth: "100%", aspectRatio: "1", containerType: "inline-size" }}
    >
      <img
        src={`/assets/badges/${game}/${id}-star-${tier || 1}.webp`}
        alt=""
        width={size}
        height={size}
        className={`block h-auto w-full object-contain ${tier === 0 ? "grayscale opacity-35" : ""}`}
      />
      {tier === 3 && plaque && (
        <span
          className="pointer-events-none absolute text-center font-bold leading-none text-white tabular-nums"
          style={{
            left: `${plaque.x}%`,
            top: `${plaque.y}%`,
            width: `${plaque.width}%`,
            transform: "translate(-50%, -50%)",
            fontSize: `${100 * Math.min(0.15, plaque.width / 100 / (digits.length * 0.65))}cqw`,
          }}
        >
          {digits}
        </span>
      )}
    </span>
  );
}
