import { scanBoardLinks } from "@tetraboard/protocol/board";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { BoardLinkCard } from "./BoardLinkCard";

export const boardLinkClasses = "text-brand underline underline-offset-2 wrap-anywhere";

function useClampedBody(text: string, clamp: boolean) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [overflow, setOverflow] = useState(false);
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
      setOverflow(clipped);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      for (const link of element.querySelectorAll("a")) link.inert = false;
    };
  }, [text, clamp]);
  return { ref, overflow };
}

export function BoardBody({ text, detailPath }: { text: string; detailPath?: string }) {
  const clamp = detailPath !== undefined;
  const { ref, overflow } = useClampedBody(text, clamp);
  const origin = window.location.origin;
  const parts: ReactNode[] = [];
  const cards: ReactNode[] = [];
  let end = 0;
  for (const occurrence of scanBoardLinks(text, origin)) {
    if (!occurrence.link) continue;
    const { start, end: linkEnd, url, link } = occurrence;
    const to = url.slice(origin.length);
    parts.push(text.slice(end, start));
    parts.push(
      <Link key={start} to={to} className={boardLinkClasses}>
        {url}
      </Link>,
    );
    cards.push(<BoardLinkCard key={start} link={link} to={to} />);
    end = linkEnd;
  }
  parts.push(text.slice(end));
  return (
    <>
      <p
        ref={ref}
        className={`whitespace-pre-wrap wrap-anywhere leading-relaxed ${clamp ? "line-clamp-5" : ""}`}
      >
        {parts}
      </p>
      {detailPath && overflow && (
        <Link to={detailPath} className={boardLinkClasses}>
          続きを読む
        </Link>
      )}
      {cards.length > 0 && <div className="grid gap-2 empty:hidden">{cards}</div>}
    </>
  );
}
