import type { RatingOpponent, RatingResult } from "@tetraboard/protocol";

const ratingChangeFormat = new Intl.NumberFormat("ja", { signDisplay: "exceptZero" });
type AppliedRating = Extract<RatingResult, { status: "rated" | "placement" }>;

function ratingLabel(
  rating: AppliedRating | RatingOpponent,
  placementGames: number,
  showPlacementChange: boolean,
) {
  if (rating.status === "placement")
    return "games" in rating ? `認定戦 ${rating.games} / ${placementGames}局` : "認定中";
  const current = Math.round(rating.rating);
  if (
    rating.status === "cpu" ||
    (!showPlacementChange && "placementCompleted" in rating && rating.placementCompleted)
  )
    return String(current);
  const change = current - Math.round(rating.previousRating);
  return `${current} (${ratingChangeFormat.format(change)})`;
}

export function RatingResultLabel({
  rating,
  placementGames,
  showPlacementChange = true,
}: {
  rating?: AppliedRating | RatingOpponent;
  placementGames: number;
  showPlacementChange?: boolean;
}) {
  if (!rating) return null;
  return (
    <span className="text-sm whitespace-nowrap text-muted tabular-nums">
      {ratingLabel(rating, placementGames, showPlacementChange)}
    </span>
  );
}
