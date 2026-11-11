import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { RatedMatchmakingGame } from "@tetraboard/protocol";
import { useAccount } from "../account/useAccount";
import { useLobbyGameRatings, type LobbyGameRatingsState } from "../lobby/useLobbyGameRatings";
import { RatedLaunchDialog } from "./RatedLaunchDialog";
import {
  claimRatedLaunch,
  hasRatedLaunchIntent,
  ratedLaunchGames,
  ratedLaunchSeen,
  ratedLaunchSeenKey,
} from "./ratedLaunch";

type Phase =
  | { status: "waiting" }
  | { status: "done" }
  | { status: "open"; games: readonly RatedMatchmakingGame[] };
type CandidateProps = {
  game?: RatedMatchmakingGame;
  visible: boolean;
  onShow: (games: readonly RatedMatchmakingGame[]) => void;
};
function LaunchCandidate({
  ratings,
  game,
  visible,
  onShow,
}: CandidateProps & { ratings: LobbyGameRatingsState }) {
  const account = useAccount();
  const games = useMemo(
    () => ratedLaunchGames.filter((value) => ratings.games?.[value].enabled),
    [ratings.games],
  );
  useEffect(() => {
    if (
      !visible ||
      account.loading ||
      account.error ||
      ratings.loading ||
      ratings.error ||
      !games.length ||
      (game && !games.includes(game))
    )
      return;
    const timer = window.setTimeout(() => onShow(games), 0);
    return () => window.clearTimeout(timer);
  }, [
    visible,
    account.loading,
    account.error,
    ratings.loading,
    ratings.error,
    games,
    game,
    onShow,
  ]);
  return null;
}
function GameLaunchCandidate(props: CandidateProps) {
  const ratings = useLobbyGameRatings();
  return <LaunchCandidate {...props} ratings={ratings} />;
}

export function RatedLaunchAnnouncement({
  game,
  ratings,
  blocked = false,
}: {
  game?: RatedMatchmakingGame;
  ratings?: LobbyGameRatingsState;
  blocked?: boolean;
}) {
  const location = useLocation();
  const excluded = blocked || hasRatedLaunchIntent(location.search, location.state);
  const [phase, setPhase] = useState<Phase>(() => ({
    status: excluded || ratedLaunchSeen() ? "done" : "waiting",
  }));
  const [visible, setVisible] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "visible",
  );
  const cancelled = useRef(false);
  const cancel = useCallback(() => {
    cancelled.current = true;
    setPhase((current) => (current.status === "waiting" ? { status: "done" } : current));
  }, []);
  const show = useCallback(
    (games: readonly RatedMatchmakingGame[]) => {
      if (cancelled.current || document.visibilityState !== "visible") return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') || !claimRatedLaunch()) {
        cancel();
        return;
      }
      setPhase({ status: "open", games });
    },
    [cancel],
  );
  const waiting = phase.status === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const interaction = () => cancel();
    const storage = (event: StorageEvent) => {
      if ((event.key === ratedLaunchSeenKey || event.key === null) && ratedLaunchSeen()) cancel();
    };
    const visibility = () => setVisible(document.visibilityState === "visible");
    for (const name of ["pointerdown", "keydown", "wheel"] as const)
      document.addEventListener(name, interaction, { capture: true, passive: true });
    window.addEventListener("storage", storage);
    document.addEventListener("visibilitychange", visibility);
    // 読み込み中に別の案内が開いた場合も、この訪問では利用者の操作を優先します。
    const observer = new MutationObserver(() => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) cancel();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = excluded ? window.setTimeout(cancel, 0) : undefined;
    return () => {
      for (const name of ["pointerdown", "keydown", "wheel"] as const)
        document.removeEventListener(name, interaction, true);
      window.removeEventListener("storage", storage);
      document.removeEventListener("visibilitychange", visibility);
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [waiting, excluded, cancel]);
  if (phase.status === "open")
    return (
      <RatedLaunchDialog
        game={game}
        games={phase.games}
        onClose={() => setPhase({ status: "done" })}
      />
    );
  if (!waiting || excluded) return null;
  const props = { game, visible, onShow: show };
  return ratings ? (
    <LaunchCandidate {...props} ratings={ratings} />
  ) : (
    <GameLaunchCandidate {...props} />
  );
}
