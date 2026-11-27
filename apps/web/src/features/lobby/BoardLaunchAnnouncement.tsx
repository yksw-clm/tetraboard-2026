import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { GameId } from "@tetraboard/protocol/games";
import { useAccount } from "../account/useAccount";
import type { BoardLaunchDialog } from "./BoardLaunchDialog";

const seenKey = "tetraboard:board-launch:seen";
const dialogSelector = '[role="dialog"], [role="alertdialog"]';
const interactionEvents = ["pointerdown", "keydown", "wheel", "click", "focusin"] as const;

function alreadySeen() {
  try {
    return localStorage.getItem(seenKey) === "1";
  } catch {
    return true;
  }
}

function markSeen() {
  if (alreadySeen()) return false;
  try {
    localStorage.setItem(seenKey, "1");
    return true;
  } catch {
    return false;
  }
}

function isForeground() {
  return document.visibilityState === "visible" && document.hasFocus();
}

function launchDialog() {
  return document.querySelector("[data-board-launch-dialog]")?.closest(dialogSelector);
}

function hasOtherDialog(own?: Element | null) {
  return [...document.querySelectorAll(dialogSelector)].some((dialog) => dialog !== own);
}

function hasActiveControl(own?: Element | null) {
  const active = document.activeElement;
  return (
    Boolean(active && active !== document.body && !own?.contains(active)) || hasOtherDialog(own)
  );
}

type Phase =
  | "waiting"
  | "closed"
  | { Dialog: typeof BoardLaunchDialog; status: "reserved" | "mounting" | "shown" };

export function BoardLaunchAnnouncement({
  game,
  acceptingPosts,
  blocked = false,
}: {
  game: GameId;
  acceptingPosts: boolean | null;
  blocked?: boolean;
}) {
  "use no memo";

  const { search, hash, state } = useLocation();
  const { loading, error } = useAccount();
  const query = new URLSearchParams(search);
  const excluded =
    blocked ||
    Boolean(hash) ||
    query.get("matchmaking") === "1" ||
    query.has("guestMerge") ||
    Boolean(
      state?.roomEntryIntent ||
      state?.registrationReturn ||
      state?.matchmakingRejoin ||
      state?.friendRoomNonce,
    );
  const [phase, setPhase] = useState<Phase>(() =>
    excluded || alreadySeen() ? "closed" : "waiting",
  );
  const [foreground, setForeground] = useState(isForeground);
  const cancelled = useRef(false);
  const shown = useRef(false);
  const waiting = phase === "waiting";
  const pending = waiting || (typeof phase === "object" && phase.status !== "shown");
  const eligible = !excluded && foreground && !loading && !error && acceptingPosts === true;

  useEffect(() => {
    if (!pending) return;
    const cancel = () => {
      if (shown.current) return;
      cancelled.current = true;
      setPhase("closed");
    };
    if (excluded || hasActiveControl()) {
      cancel();
      return;
    }
    const checkForeground = () => setForeground(isForeground());
    const storage = (event: StorageEvent) => {
      if ((event.key === seenKey || event.key === null) && alreadySeen()) cancel();
    };
    const interaction = (event: Event) => {
      if (
        event.type === "focusin" &&
        event.target instanceof Node &&
        launchDialog()?.contains(event.target)
      )
        return;
      cancel();
    };
    const observer = new MutationObserver(() => {
      if (hasOtherDialog(launchDialog())) cancel();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    for (const event of interactionEvents)
      document.addEventListener(event, interaction, { capture: true, passive: true });
    document.addEventListener("visibilitychange", checkForeground);
    window.addEventListener("focus", checkForeground);
    window.addEventListener("blur", checkForeground);
    window.addEventListener("storage", storage);
    return () => {
      observer.disconnect();
      for (const event of interactionEvents) document.removeEventListener(event, interaction, true);
      document.removeEventListener("visibilitychange", checkForeground);
      window.removeEventListener("focus", checkForeground);
      window.removeEventListener("blur", checkForeground);
      window.removeEventListener("storage", storage);
    };
  }, [excluded, pending]);

  useEffect(() => {
    if (!waiting) return;
    if (acceptingPosts === false) {
      setPhase("closed");
      return;
    }
    if (!eligible || cancelled.current) return;
    let disposed = false;
    let timer: number | undefined;
    void import("./BoardLaunchDialog")
      .then(({ BoardLaunchDialog }) => {
        if (disposed || cancelled.current) return;
        timer = window.setTimeout(() => {
          if (cancelled.current || !isForeground()) return;
          setPhase({ Dialog: BoardLaunchDialog, status: "reserved" });
        }, 0);
      })
      .catch(() => {
        if (!disposed) setPhase("closed");
      });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [acceptingPosts, eligible, waiting]);

  useLayoutEffect(() => {
    if (typeof phase !== "object" || phase.status === "shown") return;
    // 予約と同じバッチで始まった操作を、モーダルのマウントより先に反映します。
    if (cancelled.current || excluded || acceptingPosts === false) {
      setPhase("closed");
    } else if (!eligible || !isForeground()) {
      setPhase("waiting");
    } else if (phase.status === "reserved") {
      setPhase(hasActiveControl() || alreadySeen() ? "closed" : { ...phase, status: "mounting" });
    }
  }, [acceptingPosts, eligible, excluded, phase]);

  const onDisplay = useCallback((content: HTMLDivElement | null) => {
    if (!content || shown.current) return;
    const own = content.closest(dialogSelector);
    if (!own || cancelled.current || hasActiveControl(own)) {
      setPhase("closed");
    } else if (!isForeground()) {
      setPhase("waiting");
    } else if (markSeen()) {
      shown.current = true;
      setPhase((current) =>
        typeof current === "object" ? { ...current, status: "shown" } : current,
      );
    } else {
      setPhase("closed");
    }
  }, []);

  if (
    typeof phase !== "object" ||
    phase.status === "reserved" ||
    (phase.status === "mounting" && !eligible)
  )
    return null;
  const { Dialog } = phase;
  return <Dialog game={game} onDisplay={onDisplay} onClose={() => setPhase("closed")} />;
}
