import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import {
  isRatedMatchmakingGame,
  ratedMatchmakingRules,
  type GameRatingSummary,
  type RatedMatchmakingGame,
} from "@tetraboard/protocol";
import { AppButton } from "../../shared/ui/AppButton";
import { LobbyBoardPreview } from "../lobby/LobbyBoardPreview";

export function ProfileGameButtons({
  game,
  onChange,
  ratingForGame,
}: {
  game: GameId;
  onChange: (game: GameId) => void;
  ratingForGame?: (game: RatedMatchmakingGame) => GameRatingSummary | null | undefined;
}) {
  return (
    <div role="group" aria-label="プロフィールのゲーム" className="flex flex-wrap gap-2">
      {gameIds.map((id) => {
        let rating;
        if (isRatedMatchmakingGame(id)) {
          const summary = ratingForGame?.(id);
          if (summary?.status === "rated") rating = summary.rating;
          if (summary?.status === "placement") {
            rating = `認定戦 ${summary.games}/${ratedMatchmakingRules[id].placementGames}`;
          }
        }
        return (
          <AppButton
            key={id}
            appearance={id === game ? "primary" : "secondary"}
            size="compact"
            className="min-h-11 px-3 text-sm"
            aria-pressed={id === game}
            onPress={() => {
              if (id !== game) onChange(id);
            }}
          >
            <LobbyBoardPreview game={id} compact className="w-6 rotate-0 shadow-none" />
            <span className="text-left">
              <span>{gameCatalog[id].name}</span>
              {rating !== undefined && (
                <strong className="block text-xs font-bold tabular-nums">{rating}</strong>
              )}
            </span>
          </AppButton>
        );
      })}
    </div>
  );
}
