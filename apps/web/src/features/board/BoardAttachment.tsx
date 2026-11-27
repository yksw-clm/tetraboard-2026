import type { BoardAttachment as Attachment } from "@tetraboard/protocol/board";
import { useRef } from "react";
import { Link } from "react-router";
import { useBoardMedia, useBoardMediaItem, useBoardMediaNear } from "./boardMedia";

const width = "w-56 max-w-full [@media(max-width:767px)]:w-full";

export function BoardAttachment({ matchId, position }: Attachment) {
  const { attachment } = useBoardMedia();
  const ref = useRef<HTMLDivElement>(null);
  const nearby = useBoardMediaNear(ref);
  const result = useBoardMediaItem(matchId, attachment, nearby);
  if (result.status === "loading")
    return (
      <div
        ref={ref}
        role="status"
        aria-label="棋譜を読み込んでいます"
        className={`${width} grid gap-2`}
      >
        <div className="aspect-square rounded-control bg-surface-muted" />
        <div className="h-5" />
      </div>
    );
  const selected = result.status === "ready" ? result.data.frameAt(position) : null;
  if (!selected || result.status !== "ready")
    return <p className="text-sm text-muted">棋譜を表示できません。</p>;
  const { Board } = result.data;
  const shogi = selected.game === "shogi" || selected.game === "four-shogi";
  return (
    <div className={`${width} grid gap-2`}>
      <div
        className={`pointer-events-none aspect-square min-w-0 [--board-size:100%] [&_[data-hand-kind]>.tabular-nums]:origin-top-right [&_[data-hand-kind]>.tabular-nums]:scale-75 ${shogi ? "[@media(max-width:767px)]:aspect-auto" : ""}`}
      >
        <Board {...selected} />
      </div>
      <Link
        to={`/matches/${matchId}?position=${position}`}
        className="relative z-10 w-fit text-sm text-brand underline underline-offset-2"
      >
        {selected.frame.label}
      </Link>
    </div>
  );
}
