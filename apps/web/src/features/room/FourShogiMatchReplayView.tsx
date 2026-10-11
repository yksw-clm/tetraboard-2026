import { playerAppearance } from "./roomCommonPresentation";
import type { ReplayFourShogiMatch } from "@tetraboard/protocol";
import { useState, type ReactNode } from "react";
import type { Side } from "@tetraboard/four-shogi";
import { useBoardRotation } from "./useBoardRotation";
import { rotatedShogiViewer } from "./boardRotation";
import { PlayerCardView } from "./PlayerCardView";
import { ShogiSideBadge } from "./FourShogiPlayerCard";
import { FourShogiBoardLayout } from "./FourShogiBoardLayout";
import { FourShogiGameResultView } from "./FourShogiGameResultView";
import {
  shogiCardPosition,
  shogiPlayerRank,
  shogiMatchViewerSide,
} from "./fourShogiRoomPresentation";
import type { FourShogiReplayFrame } from "./fourShogiReplay";
import { SavedMatchReplayView } from "./SavedMatchReplayView";
export default function FourShogiMatchReplayView({
  match,
  frames,
}: {
  match: ReplayFourShogiMatch;
  frames: FourShogiReplayFrame[];
}) {
  const { rotation, rotate } = useBoardRotation();
  const [index, setIndex] = useState(frames.length - 1);
  const frame = frames[index]!;
  const viewerSide = rotatedShogiViewer(shogiMatchViewerSide(match), rotation);
  const cardFor = (side: Side): ReactNode => {
    const player = match.participants.find((entry) => entry.side === side)!;
    return (
      <PlayerCardView
        key={player.id}
        shogi
        profileTarget={
          player.kind === "human" && player.retired
            ? undefined
            : { source: "match", matchId: match.id, playerId: player.id }
        }
        profileMode={match.settings.mode}
        player={player}
        self={player.id === match.selfPlayerId}
        host={player.seat === 0}
        position={shogiCardPosition(side, viewerSide)}
        clock={null}
        rank={shogiPlayerRank(frame.game, side)}
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
    west: cardFor("west"),
    north: cardFor("north"),
    east: cardFor("east"),
  } satisfies Record<Side, ReactNode>;
  const replay = {
    frames,
    index,
    select: (next: number) => {
      if (Number.isInteger(next) && next >= 0 && next < frames.length) setIndex(next);
    },
  };
  const board = (
    <FourShogiBoardLayout
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
      theme="four-shogi"
      result={
        <FourShogiGameResultView
          lastRound={lastRound}
          replay={{ frames, loading: false, error: null }}
        />
      }
    />
  );
}
