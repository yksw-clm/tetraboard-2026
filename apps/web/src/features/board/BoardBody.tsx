import { scanBoardLinks } from "@tetraboard/protocol/board";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { BoardDetailLink } from "./BoardEntry";
import { BoardLinkCard } from "./BoardLinkCard";
import { useBoardMediaNear } from "./boardMedia";

export const boardLinkClasses = "text-brand underline underline-offset-2 wrap-anywhere";

function useClampedBody(text: string, clamp: boolean) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [measurement, setMeasurement] = useState<{ text: string; overflow: boolean } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!clamp || !element) return;
    const measure = () => {
      const clipped = element.scrollHeight > element.clientHeight;
      const bottom = element.getBoundingClientRect().bottom;
      // 省略範囲に完全に隠れたリンクにはキーボードフォーカスを移しません。
      for (const link of element.querySelectorAll("a")) {
        link.inert = clipped && link.getBoundingClientRect().top >= bottom;
      }
      setMeasurement((current) =>
        current?.text === text && current.overflow === clipped
          ? current
          : { text, overflow: clipped },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      for (const link of element.querySelectorAll("a")) link.inert = false;
    };
  }, [text, clamp]);
  return {
    ref,
    overflow: clamp ? (measurement?.text === text ? measurement.overflow : null) : false,
  };
}

export function BoardBody({
  text,
  detailPath,
  detailLink,
}: {
  text: string;
  detailPath?: string;
  detailLink?: BoardDetailLink;
}) {
  const clamp = detailPath !== undefined;
  const { ref, overflow } = useClampedBody(text, clamp);
  const origin = window.location.origin;
  const links = scanBoardLinks(text, origin);
  const showCards = overflow === false && links.some(({ link }) => link !== null);
  const cardsRef = useRef<HTMLSpanElement>(null);
  const nearby = useBoardMediaNear(cardsRef, showCards);
  const parts: ReactNode[] = [];
  const cards: ReactNode[] = [];
  let end = 0;
  for (const occurrence of links) {
    if (!occurrence.link) continue;
    const { start, end: linkEnd, url, link } = occurrence;
    const to = url.slice(origin.length);
    parts.push(text.slice(end, start));
    parts.push(
      <Link key={start} to={to} className={`relative z-10 ${boardLinkClasses}`}>
        {url}
      </Link>,
    );
    if (showCards) cards.push(<BoardLinkCard key={start} link={link} to={to} nearby={nearby} />);
    end = linkEnd;
  }
  parts.push(text.slice(end));
  return (
    <>
      <div className="relative">
        <p
          ref={ref}
          className={`whitespace-pre-wrap wrap-anywhere leading-relaxed ${clamp ? "line-clamp-5" : ""}`}
        >
          {parts}
        </p>
        {showCards && (
          <span
            ref={cardsRef}
            aria-hidden="true"
            className="pointer-events-none absolute top-full left-0 size-px"
          />
        )}
      </div>
      {detailPath && overflow && (
        <Link to={detailPath} {...detailLink} className={`relative z-10 w-fit ${boardLinkClasses}`}>
          続きを読む
        </Link>
      )}
      {cards.length > 0 && <div className="grid gap-2 empty:hidden">{cards}</div>}
    </>
  );
}
