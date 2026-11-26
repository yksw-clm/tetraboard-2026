import { useEffect, useRef } from "react";
import type { GameId } from "@tetraboard/protocol/games";

const url = "/api/board-preview-views";

function sendBoardPreviewView(game: GameId) {
  try {
    const body = JSON.stringify({ game });
    if (typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    } else {
      void fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // 計測の失敗でロビーの表示に影響させません。
  }
}

export function useBoardPreviewView(game: GameId) {
  const ref = useRef<HTMLElement>(null);
  const sent = useRef(false);
  useEffect(() => {
    const section = ref.current;
    if (!section || sent.current || typeof window.IntersectionObserver !== "function") return;
    let observing = true;
    const observer = new window.IntersectionObserver((entries) => {
      if (!observing || !entries.some((entry) => entry.isIntersecting)) return;
      observing = false;
      sent.current = true;
      observer.disconnect();
      sendBoardPreviewView(game);
    });
    observer.observe(section);
    return () => {
      if (observing) observer.disconnect();
      observing = false;
    };
  }, [game]);
  return ref;
}
