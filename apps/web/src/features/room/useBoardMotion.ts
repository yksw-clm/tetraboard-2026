import { useLayoutEffect, useRef } from "react";
import { boardMotionChanges, type BoardMotionFrame } from "./boardMotion";
import { useBrowserSettings } from "../../shared/useBrowserSettings";

const landing: Keyframe[] = [
  { transform: "translateY(-8%) scale(1.08)", offset: 0 },
  { transform: "translateY(0) scale(0.98)", offset: 0.4 },
  { transform: "translateY(0) scale(1)", offset: 1 },
];

function flipFrames(from: string, to: string): Keyframe[] {
  return [
    { transform: "scaleX(1)", backgroundImage: `var(--stone-${from})`, offset: 0 },
    { transform: "scaleX(0.03)", backgroundImage: `var(--stone-${from})`, offset: 0.49 },
    { transform: "scaleX(0.03)", backgroundImage: `var(--stone-${to})`, offset: 0.51 },
    { transform: "scaleX(1)", backgroundImage: `var(--stone-${to})`, offset: 1 },
  ];
}

export function useBoardMotion(frame: BoardMotionFrame) {
  const { boardAnimationsEnabled } = useBrowserSettings();
  const board = useRef<HTMLDivElement>(null);
  const previous = useRef<(BoardMotionFrame & { enabled: boolean }) | null>(null);
  const animations = useRef(new Set<Animation>());

  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    function reset() {
      for (const animation of animations.current) animation.cancel();
      animations.current.clear();
      previous.current = null;
    }
    media.addEventListener("change", reset);
    document.addEventListener("visibilitychange", reset);
    return () => {
      media.removeEventListener("change", reset);
      document.removeEventListener("visibilitychange", reset);
      reset();
    };
  }, []);

  // 確定した描画同士を比較し、時計などの再描画では演出を作り直しません。
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { ...frame, enabled: boardAnimationsEnabled };
    if (
      before &&
      before.enabled === boardAnimationsEnabled &&
      before.context?.scope === frame.context?.scope &&
      before.orientation === frame.orientation &&
      before.cells.every((row, y) => row.every((cell, x) => cell === frame.cells[y]?.[x]))
    )
      return;
    for (const animation of animations.current) animation.cancel();
    animations.current.clear();
    if (
      !boardAnimationsEnabled ||
      !before?.enabled ||
      document.visibilityState === "hidden" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    for (const change of boardMotionChanges(before, frame)) {
      const piece = board.current?.querySelector<HTMLElement | SVGElement>(
        `[data-board-piece="${change.x},${change.y}"]`,
      );
      if (!piece?.animate) continue;
      const animation = piece.animate(change.from ? flipFrames(change.from, change.to) : landing, {
        duration: change.from ? 220 : 150,
        easing: change.from ? "ease-in-out" : "linear",
      });
      animations.current.add(animation);
      animation.onfinish = animation.oncancel = () => animations.current.delete(animation);
    }
  });
  return board;
}
