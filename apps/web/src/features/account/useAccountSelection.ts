import { defaultGameId, isGameId } from "@tetraboard/protocol/games";
import { type MatchGame, type RoomMode } from "@tetraboard/protocol";
import { useLocation, useNavigate } from "react-router";

type Selection = { game: MatchGame; modes: Record<MatchGame, RoomMode> };
type AccountNavigationState = {
  accountSelection?: Selection;
  accountSelections?: Partial<Record<"stats" | "history", Selection>>;
};

export function createAccountSelection(game: MatchGame): Selection {
  return {
    game,
    modes: {
      "four-reversi": "singles",
      "four-shogi": "singles",
      reversi: "singles",
      shogi: "singles",
    },
  };
}

// ブラウザの履歴に選択を置き、棋譜閲覧や再読み込みから戻っても各カードを復元します。
export function useAccountSelection() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state ?? {}) as AccountNavigationState;
  const candidates = [
    state.accountSelection,
    state.accountSelections?.history,
    state.accountSelections?.stats,
  ];
  // 旧画面で選択が異なる場合は、閲覧していた棋譜側を優先して復元します。
  const game: MatchGame =
    candidates.find((stored) => isGameId(stored?.game))?.game ?? defaultGameId;
  const storedMode = (target: MatchGame): RoomMode =>
    candidates
      .map((stored) => stored?.modes?.[target])
      .find((mode) => mode === "singles" || mode === "doubles") ?? "singles";
  const modes: Record<MatchGame, RoomMode> = {
    reversi: "singles",
    shogi: "singles",
    "four-reversi": storedMode("four-reversi"),
    "four-shogi": storedMode("four-shogi"),
  };
  const update = (next: Selection) => {
    void navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: {
        ...state,
        accountSelection: next,
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
