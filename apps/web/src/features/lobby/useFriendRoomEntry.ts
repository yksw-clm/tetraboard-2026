import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { takeFriendRoomIntent, type FriendRoomIntent } from "../../shared/friendRoomIntent";

export type FriendRoomSubmission = FriendRoomIntent & { isCurrent: () => boolean };

type LobbyVisit = {
  key: string;
  intent: FriendRoomIntent | undefined;
  replacementState?: object;
};

export function useFriendRoomEntry(
  game: GameId,
  canSubmit: boolean,
  submit: (request: FriendRoomSubmission) => void,
) {
  const location = useLocation();
  const navigate = useNavigate();
  const lobbyPath = gameCatalog[game].lobbyPath;
  const visit = useRef<LobbyVisit | null>(null);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (location.pathname !== lobbyPath) {
      visit.current = null;
      return;
    }
    const previous = visit.current;
    if (previous?.key === location.key) return;
    if (previous?.replacementState && location.state === previous.replacementState) {
      previous.key = location.key;
      previous.replacementState = undefined;
      return;
    }
    const nonce = location.state?.friendRoomNonce;
    // 認証の確認を待つ間も、依頼は最初に表示した履歴項目だけで保持します。
    visit.current =
      typeof nonce === "string"
        ? { key: location.key, intent: takeFriendRoomIntent(nonce, game) }
        : null;
  }, [game, lobbyPath, location]);

  const submitFriendRoom = useEffectEvent(submit);
  useEffect(() => {
    const current = visit.current;
    if (!canSubmit || !current || current.key !== location.key) return;

    if (typeof location.state?.friendRoomNonce === "string") {
      if (current.replacementState) return;
      const { friendRoomNonce: _nonce, ...state } = location.state;
      current.replacementState = state;
      void navigate(location.pathname + location.search + location.hash, { replace: true, state });
      return;
    }

    // replace 後の履歴項目が表示されてから作成を開始します。
    const intent = current.intent;
    if (!intent) return;
    current.intent = undefined;
    const isCurrent = () =>
      mounted.current && visit.current === current && current.key === location.key;
    queueMicrotask(() => {
      if (isCurrent()) submitFriendRoom({ ...intent, isCurrent });
    });
  }, [canSubmit, location, navigate]);
}
