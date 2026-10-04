import { defaultGameId, isGameId } from "@tetraboard/protocol/games";
import { type MatchGame, type RoomMode } from "@tetraboard/protocol";
import { useLocation, useNavigate } from "react-router";

type Selection = { game: MatchGame; modes: Record<MatchGame, RoomMode> };
type AccountNavigationState = {
  accountSelections?: Partial<Record<"stats" | "history", Selection>>;
};

// ブラウザの履歴に選択を置き、棋譜閲覧や再読み込みから戻っても各カードを復元します。
export function useAccountSelection(section: "stats" | "history") {
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state ?? {}) as AccountNavigationState;
  const stored = state.accountSelections?.[section];
  const game: MatchGame = isGameId(stored?.game) ? stored.game : defaultGameId;
  const modes: Record<MatchGame, RoomMode> = {
    "four-reversi": stored?.modes?.["four-reversi"] === "doubles" ? "doubles" : "singles",
    "four-shogi": stored?.modes?.["four-shogi"] === "doubles" ? "doubles" : "singles",
  };
  const update = (next: Selection) => {
    void navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: {
        ...state,
        accountSelections: { ...state.accountSelections, [section]: next },
      },
    });
  };
  return {
    game,
    mode: modes[game],
    setGame: (next: MatchGame) => update({ game: next, modes }),
    setMode: (mode: RoomMode) => update({ game, modes: { ...modes, [game]: mode } }),
  };
}
