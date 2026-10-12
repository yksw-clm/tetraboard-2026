import { useState } from "react";
import type { ReplayReversiMatch } from "@tetraboard/protocol";
import type { QuarterTurn } from "./boardRotation";
import { playerAppearance } from "./roomCommonPresentation";
import { FourReversiBoard } from "./FourReversiBoard";
import { ReversiBoardLayout } from "./ReversiBoardLayout";
import { ReversiPlayerCard } from "./ReversiPlayerCard";
import { ReversiResult } from "./ReversiResult";
import { useReversiReplay } from "./reversiReplay";
import { SavedMatchReplayView } from "./SavedMatchReplayView";
export default function ReversiMatchReplayView({ match }: { match: ReplayReversiMatch }) {
  const [rotation, setRotation] = useState<QuarterTurn>(0);
  const lastRound = {
    game: match.game,
    replay: match.replay,
    players: match.participants.map((p) => ({ ...p, appearance: playerAppearance(p) })),
  };
  const replay = useReversiReplay(lastRound);
  const game = replay.frame?.game ?? match.game;
  const anchor =
    match.participants.find((p) => p.id === match.selfPlayerId) ??
    match.participants.find((p) => p.color === "black")!;
  const seats = [anchor, match.participants.find((p) => p.id !== anchor.id)!];
  const board = (
    <ReversiBoardLayout>
      {seats.map((p, i) => (
        <ReversiPlayerCard
          key={p.id}
          player={p}
          position={(i === 0) === (rotation === 0) ? "bottom" : "top"}
          self={p.id === match.selfPlayerId}
          host={p.seat === 0}
          game={game}
          profileTarget={
            p.kind === "human" && p.retired
              ? undefined
              : { source: "match", matchId: match.id, playerId: p.id }
          }
        />
      ))}
      <FourReversiBoard
        label="リバーシの盤面"
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
      theme="reversi"
      onRotate={() => setRotation((r) => (r === 0 ? 2 : 0))}
      result={<ReversiResult lastRound={lastRound} />}
    />
  );
}
