import { playerAppearance } from "./roomCommonPresentation";
import type { ReplayShogiMatch } from "@tetraboard/protocol";
import { useState, type ReactNode } from "react";
import type { Side } from "@tetraboard/shogi";
import { useBoardRotation } from "./useBoardRotation";
import { otherSide } from "@tetraboard/shogi";
import { PlayerCardView } from "./PlayerCardView";
import { ShogiSideBadge } from "./ShogiPlayerCard";
import { FourShogiBoardLayout as ShogiBoardLayout } from "./FourShogiBoardLayout";
import { ShogiResult } from "./ShogiResult";
import type { ShogiReplayFrame } from "./standardShogiReplay";
import { SavedMatchReplayView } from "./SavedMatchReplayView";
export default function ShogiMatchReplayView({
  match,
  frames,
}: {
  match: ReplayShogiMatch;
  frames: ShogiReplayFrame[];
}) {
  const { rotation, rotate } = useBoardRotation();
  const [index, setIndex] = useState(frames.length - 1);
  const frame = frames[index]!;
  const base =
    match.selfPlayerId && match.game.players.north === match.selfPlayerId ? "north" : "south";
  const viewerSide = rotation % 2 ? otherSide(base) : base;
  const cardFor = (side: Side): ReactNode => {
    const player = match.participants.find((entry) => entry.side === side)!;
    return (
      <PlayerCardView
        key={player.id}
        shogi
        game="shogi"
        profileTarget={{ source: "match", matchId: match.id, playerId: player.id }}
        player={player}
        self={player.id === match.selfPlayerId}
        host={player.seat === 0}
        position={side === viewerSide ? "bottom" : "top"}
        clock={null}
        rank={
          frame.game.status === "finished"
            ? {
                rank:
                  frame.game.result.winner === side || frame.game.result.winner === null ? 1 : 2,
                label:
                  frame.game.result.winner === null
                    ? "引き分け"
                    : frame.game.result.winner === side
                      ? "勝利"
                      : "敗北",
              }
            : null
        }
        score={
          <ShogiSideBadge
            side={side}
            proposed={
              frame.game.drawProposals.includes(side) &&
              !frame.game.eliminations.some((entry) => entry.side === side)
            }
          />
        }
      />
    );
  };
  const cards = {
    south: cardFor("south"),
    north: cardFor("north"),
  } satisfies Record<Side, ReactNode>;
  const replay = {
    frames,
    index,
    select: (next: number) => {
      if (Number.isInteger(next) && next >= 0 && next < frames.length) setIndex(next);
    },
  };
  const board = (
    <ShogiBoardLayout
      standard
      game={frame.game}
      viewerSide={viewerSide}
      revision={`${match.id}:${index}`}
      canPlay={false}
      legalActions={[]}
      checkState={frame.checkState}
      onAction={() => {}}
      playerCards={cards}
    />
  );
  const lastRound = {
    roundId: match.id,
    game: match.game,
    players: match.participants.map((player) => ({
      ...player,
      appearance: playerAppearance(player),
    })),
    eventCount: match.replay.eventCount,
  };
  return (
    <SavedMatchReplayView
      match={match}
      board={board}
      onRotate={rotate}
      replay={replay}
      theme="shogi"
      result={<ShogiResult lastRound={lastRound} />}
    />
  );
}
