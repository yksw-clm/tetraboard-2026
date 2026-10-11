import { useState } from "react";
import type { ReplayGomokuMatch } from "@tetraboard/protocol";
import type { QuarterTurn } from "./boardRotation";
import { playerAppearance } from "./roomCommonPresentation";
import { GomokuBoard } from "./GomokuBoard";
import { ReversiBoardLayout } from "./ReversiBoardLayout";
import { GomokuPlayerCard } from "./GomokuPlayerCard";
import { GomokuResult } from "./GomokuResult";
import { useGomokuReplay } from "./gomokuReplay";
import { SavedMatchReplayView } from "./SavedMatchReplayView";
export default function GomokuMatchReplayView({ match }: { match: ReplayGomokuMatch }) {
  const [rotation, setRotation] = useState<QuarterTurn>(0);
  const lastRound = {
    settings: match.settings,
    game: match.game,
    replay: match.replay,
    players: match.participants.map((p) => ({ ...p, appearance: playerAppearance(p) })),
  };
  const replay = useGomokuReplay(lastRound);
  const game = replay.frame?.game ?? match.game;
  const anchor =
    match.participants.find((p) => p.id === match.selfPlayerId) ??
    match.participants.find((p) => p.color === "black")!;
  const seats = [anchor, match.participants.find((p) => p.id !== anchor.id)!];
  const board = (
    <ReversiBoardLayout>
      {seats.map((p, i) => (
        <GomokuPlayerCard
          key={p.id}
          player={p}
          position={(i === 0) === (rotation === 0) ? "bottom" : "top"}
          self={p.id === match.selfPlayerId}
          host={p.seat === 0}
          game={game}
          profileTarget={{ source: "match", matchId: match.id, playerId: p.id }}
        />
      ))}
      <GomokuBoard
        label="五目並べの盤面"
        game={game}
        rotation={rotation}
        legalMoves={[]}
        canPlay={false}
        onPlaceStone={() => {}}
      />
    </ReversiBoardLayout>
  );
  return (
    <SavedMatchReplayView
      match={match}
      board={board}
      replay={replay}
      theme="gomoku"
      onRotate={() => setRotation((r) => (r === 0 ? 2 : 0))}
      result={<GomokuResult lastRound={lastRound} />}
    />
  );
}
