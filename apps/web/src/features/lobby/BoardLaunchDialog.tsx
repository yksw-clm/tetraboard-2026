import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppDialog } from "../../shared/ui/AppDialog";
import { gameThemes } from "../../shared/ui/appTheme";

export function BoardLaunchDialog({ game, onClose }: { game?: GameId; onClose: () => void }) {
  return (
    <AppDialog title="掲示板を公開しました！" theme={game && gameThemes[game]} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="space-y-2 text-sm leading-relaxed">
          <p>対局の感想や質問を投稿したり、棋譜の気になった局面を添付したりできます。</p>
          <p>掲示板はどなたでも読めます。投稿や返信にはアカウント連携が必要です。</p>
        </div>
        {game ? (
          <AppButtonLink
            appearance="primary"
            className="min-h-11 w-full"
            to={`${gameCatalog[game].lobbyPath}/posts`}
            onClick={onClose}
          >
            掲示板を見る
          </AppButtonLink>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {gameIds.map((id) => (
              <AppButtonLink
                key={id}
                className="min-h-11 min-w-0 px-2 whitespace-normal"
                to={`${gameCatalog[id].lobbyPath}/posts`}
                onClick={onClose}
              >
                {gameCatalog[id].name}
              </AppButtonLink>
            ))}
          </div>
        )}
        <AppButton appearance="quiet" className="min-h-11 w-full" onPress={onClose}>
          あとで
        </AppButton>
      </div>
    </AppDialog>
  );
}
