import type { ReactNode } from "react";
import { cn } from "@heroui/react";
import { PlayerAvatar } from "./PlayerAvatar";
import { PlayerRankBadge } from "./PlayerRankBadge";
import type { ResultPlayer } from "./gameResultPresentation";

const resultColumns = "grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-center gap-3";

export function ResultParticipant({ player }: { player: ResultPlayer }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2" data-player-id={player.id}>
      <PlayerAvatar appearance={player.appearance} className="size-8" />
      <span className="min-w-0 text-sm font-bold [overflow-wrap:anywhere]">{player.name}</span>
    </span>
  );
}

export function GameResultRow({
  player,
  rank,
  details,
  right,
}: {
  player: ResultPlayer;
  rank?: number;
  details: ReactNode;
  right?: ReactNode;
}) {
  return (
    <li
      className={cn(
        right ? resultColumns : "flex items-center gap-3",
        "border-b border-solid border-line py-3",
      )}
      aria-label={`${player.name}の結果`}
    >
      <div
        className={cn(
          "grid min-w-0 flex-1 items-center gap-2",
          rank !== undefined
            ? "grid-cols-[30px_auto_minmax(0,1fr)]"
            : "grid-cols-[auto_minmax(0,1fr)]",
        )}
      >
        {rank !== undefined && <PlayerRankBadge rank={rank} className="text-xs" />}
        {details}
        <ResultParticipant player={player} />
      </div>
      {right && (
        <div className="min-w-0 flex-1 text-xs" aria-label="撃破したプレイヤー">
          {right}
        </div>
      )}
    </li>
  );
}

export function GameResultList({
  children,
  rightHeading,
}: {
  children: ReactNode;
  rightHeading?: string;
}) {
  return (
    <>
      {rightHeading && (
        <div className={cn(resultColumns, "mt-3 text-xs font-bold text-muted")}>
          <span />
          <span>{rightHeading}</span>
        </div>
      )}
      <ul className="m-0 list-none p-0">{children}</ul>
    </>
  );
}

export function GameResultTeam({
  name,
  outcome,
  children,
  rightHeading,
}: {
  name: string;
  outcome: "勝利" | "敗北" | "引き分け";
  children: ReactNode;
  rightHeading?: string;
}) {
  return (
    <section aria-label={`${name} ${outcome}`} className="mt-4">
      <h3 className="m-0 text-sm font-bold">
        {name}：{outcome}
      </h3>
      <GameResultList rightHeading={rightHeading}>{children}</GameResultList>
    </section>
  );
}
