import type { ReactNode } from "react";
import { PlayerAvatar } from "./PlayerAvatar";
import { PlayerRankBadge } from "./PlayerRankBadge";
import type { ResultPlayer } from "./gameResultPresentation";

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
      className="flex items-center gap-3 border-b border-solid border-line py-3"
      aria-label={`${player.name}の結果`}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {rank !== undefined && <PlayerRankBadge rank={rank} className="text-xs" />}
        <ResultParticipant player={player} />
        {details}
      </div>
      {right && (
        <div className="min-w-0 flex-1 text-xs" aria-label="撃破したプレイヤー">
          {right}
        </div>
      )}
    </li>
  );
}

export function GameResultList({ children }: { children: ReactNode }) {
  return <ul className="m-0 list-none p-0">{children}</ul>;
}

export function GameResultTeam({
  name,
  outcome,
  children,
}: {
  name: string;
  outcome: "勝利" | "敗北" | "引き分け";
  children: ReactNode;
}) {
  return (
    <section aria-label={`${name} ${outcome}`} className="mt-4">
      <h3 className="m-0 text-sm font-bold">
        {name}：{outcome}
      </h3>
      <GameResultList>{children}</GameResultList>
    </section>
  );
}
