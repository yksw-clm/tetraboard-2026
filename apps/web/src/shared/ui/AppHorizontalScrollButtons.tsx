import { useLayoutEffect, useState, type RefObject } from "react";
import { AppButton } from "./AppButton";
import { AppIcon } from "./AppIcon";

export function AppHorizontalScrollButtons({
  scrollRef,
  label,
  contentKey,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  label: string;
  contentKey?: unknown;
}) {
  const [scrollable, setScrollable] = useState({ left: false, right: false });
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => {
      const left = element.scrollLeft > 1;
      const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setScrollable((current) =>
        current.left === left && current.right === right ? current : { left, right },
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    const frame = requestAnimationFrame(update);
    element.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, [scrollRef, contentKey]);

  function scroll(direction: number) {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollBy({
      left: direction * element.clientWidth * 0.75,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }

  return (
    <>
      {(["left", "right"] as const).map((direction) =>
        scrollable[direction] ? (
          <AppButton
            key={direction}
            appearance="secondary"
            size="compact"
            isIconOnly
            aria-label={`${label}を${direction === "left" ? "左" : "右"}へスクロール`}
            className={`absolute top-1/2 z-20 size-11 min-h-11 min-w-11 -translate-y-1/2 rounded-full p-0 shadow-panel ${direction === "left" ? "left-0" : "right-0"}`}
            onPress={() => scroll(direction === "left" ? -1 : 1)}
          >
            <AppIcon name="arrow" className={direction === "left" ? "rotate-180" : ""} />
          </AppButton>
        ) : null,
      )}
    </>
  );
}
