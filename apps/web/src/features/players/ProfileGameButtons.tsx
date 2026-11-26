import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import { AppButton } from "../../shared/ui/AppButton";
import { LobbyBoardPreview } from "../lobby/LobbyBoardPreview";

export function ProfileGameButtons({
  game,
  onChange,
}: {
  game: GameId;
  onChange: (game: GameId) => void;
}) {
  return (
    <div role="group" aria-label="プロフィールのゲーム" className="flex flex-wrap gap-2">
      {gameIds.map((id) => (
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
          {gameCatalog[id].name}
        </AppButton>
      ))}
    </div>
  );
}
