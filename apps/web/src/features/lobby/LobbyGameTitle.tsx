import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { AppButton } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import { LobbyBoardPreview } from "./LobbyBoardPreview";

const descriptions = {
  "four-gomoku": "4色でつなぐ五連。ひとりでも、チームでも。",
  gomoku: "五つの石をつなぐ、黒と白の真剣勝負。",
  reversi: "黒と白で楽しむリバーシ。",
  shogi: "先手と後手で楽しむ将棋。",
  "four-reversi": "4色で楽しむリバーシ。",
  "four-shogi": "4方向から楽しむ将棋。",
} satisfies Record<GameId, string>;

export function LobbyGameTitle({ game, onRules }: { game: GameId; onRules: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-5 [@media(max-width:767px)]:gap-2.5">
      <span className="grid size-16 shrink-0 place-items-center [@media(max-width:767px)]:size-10">
        <LobbyBoardPreview game={game} compact className="!w-12 [@media(max-width:767px)]:!w-9" />
      </span>
      <div className="min-w-0 [@media(max-width:767px)]:grid [@media(max-width:767px)]:grid-cols-[auto_1fr] [@media(max-width:767px)]:items-center [@media(max-width:767px)]:gap-x-2">
        <h1 className="text-[36px] leading-[1.35] tracking-[0.02em] [@media(max-width:767px)]:text-[22px]">
          {gameCatalog[game].name}
        </h1>
        <p className="mt-[6px]! text-sm text-muted [@media(max-width:767px)]:col-span-2 [@media(max-width:767px)]:row-start-2 [@media(max-width:767px)]:mt-0! [@media(max-width:767px)]:text-xs">
          ひとりでも、友達とでも。{descriptions[game]}
        </p>
        <AppButton
          className="-ml-[9px] px-[9px] text-[13px] [@media(max-width:767px)]:ml-0 [@media(max-width:767px)]:min-h-11 [@media(max-width:767px)]:justify-self-start [@media(max-width:767px)]:px-1.5"
          appearance="quiet"
          type="button"
          onPress={onRules}
        >
          <AppIcon name="book" />
          遊び方
        </AppButton>
      </div>
    </div>
  );
}
