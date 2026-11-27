import { useEffect, useRef, useState } from "react";
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

function hasActiveControl() {
  return (
    Boolean(document.activeElement && document.activeElement !== document.body) ||
    Boolean(document.querySelector(dialogSelector))
  );
}

async function readPostingAvailability(signal: AbortSignal): Promise<boolean> {
  // 投稿受付は全ゲーム共通です。
  const response = await fetch("/api/games/four-shogi/posts?limit=1", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) return false;
  const data: unknown = await response.json();
  return Boolean(
    data && typeof data === "object" && "acceptingPosts" in data && data.acceptingPosts === true,
  );
}

type Phase = "waiting" | "closed" | { Dialog: typeof BoardLaunchDialog };

export function BoardLaunchAnnouncement({
  game,
  acceptingPosts,
  blocked = false,
}: {
  game?: GameId;
  acceptingPosts?: boolean | null;
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
  const [homeAvailability, setHomeAvailability] = useState<boolean | null>(null);
  const cancelled = useRef(false);
  const waiting = phase === "waiting";
  const eligible = waiting && !excluded && foreground && !loading && !error;
  const available = game ? acceptingPosts : homeAvailability;

  useEffect(() => {
    if (!waiting) return;
    const cancel = () => {
      cancelled.current = true;
      setPhase((current) => (current === "waiting" ? "closed" : current));
    };
    if (excluded || hasActiveControl()) {
      cancel();
      return;
    }
    const checkForeground = () => setForeground(isForeground());
    const storage = (event: StorageEvent) => {
      if ((event.key === seenKey || event.key === null) && alreadySeen()) cancel();
    };
    const observer = new MutationObserver(() => {
      if (document.querySelector(dialogSelector)) cancel();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    for (const event of interactionEvents)
      document.addEventListener(event, cancel, { capture: true, passive: true });
    document.addEventListener("visibilitychange", checkForeground);
    window.addEventListener("focus", checkForeground);
    window.addEventListener("blur", checkForeground);
    window.addEventListener("storage", storage);
    return () => {
      observer.disconnect();
      for (const event of interactionEvents) document.removeEventListener(event, cancel, true);
      document.removeEventListener("visibilitychange", checkForeground);
      window.removeEventListener("focus", checkForeground);
      window.removeEventListener("blur", checkForeground);
      window.removeEventListener("storage", storage);
    };
  }, [excluded, waiting]);

  useEffect(() => {
    if (game || !eligible || cancelled.current || homeAvailability !== null) return;
    const controller = new AbortController();
    // StrictModeの再マウントや、受付取得前に始まる既存操作を先に反映します。
    const timer = window.setTimeout(() => {
      if (cancelled.current || !isForeground()) return;
      void readPostingAvailability(controller.signal)
        .catch(() => false)
        .then((value) => {
          if (!controller.signal.aborted) setHomeAvailability(value);
        });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [eligible, game, homeAvailability]);

  useEffect(() => {
    if (!waiting) return;
    if (available === false) {
      setPhase("closed");
      return;
    }
    if (!eligible || available !== true || cancelled.current) return;
    let disposed = false;
    let timer: number | undefined;
    void import("./BoardLaunchDialog")
      .then(({ BoardLaunchDialog }) => {
        if (disposed || cancelled.current) return;
        timer = window.setTimeout(() => {
          if (cancelled.current || !isForeground()) return;
          if (hasActiveControl() || !markSeen()) {
            setPhase("closed");
            return;
          }
          setPhase({ Dialog: BoardLaunchDialog });
        }, 0);
      })
      .catch(() => {
        if (!disposed) setPhase("closed");
      });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [available, eligible, waiting]);

  if (typeof phase !== "object") return null;
  const { Dialog } = phase;
  return <Dialog game={game} onClose={() => setPhase("closed")} />;
}
