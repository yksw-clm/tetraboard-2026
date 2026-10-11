import { useBoardRotation } from "./useBoardRotation";
import { rotatedSeatIndex } from "./boardRotation";
import { seatPositions } from "./roomCommonPresentation";
import { colorSeats } from "./fourGomokuPresentation";
import type { ReplayFourGomokuMatch } from "@tetraboard/protocol";
import { playerAppearance } from "./roomCommonPresentation";
import { GomokuBoard } from "./GomokuBoard";
import { RoomBoardLayout } from "./RoomLayout";
import { FourGomokuPlayerCard } from "./FourGomokuPlayerCard";
import { FourGomokuResult } from "./FourGomokuResult";
import { useFourGomokuReplay } from "./fourGomokuReplay";
import { SavedMatchReplayView } from "./SavedMatchReplayView";
export default function FourGomokuMatchReplayView({ match }: { match: ReplayFourGomokuMatch }) {
  const { rotation, rotate } = useBoardRotation();
  const lastRound = {
    settings: match.settings,
    game: match.game,
    replay: match.replay,
    players: match.participants.map((p) => ({ ...p, appearance: playerAppearance(p) })),
  };
  const replay = useFourGomokuReplay(lastRound);
  const game = replay.frame?.game ?? match.game;
  const seats = colorSeats(match.participants, match.selfPlayerId);
  const board = (
    <RoomBoardLayout hasNotice={false}>
      {seats.map((p, i) => (
        <FourGomokuPlayerCard
          key={p.id}
          player={p}
          position={seatPositions[rotatedSeatIndex(i, rotation)]}
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
      <GomokuBoard
        label="四人五目並べの盤面"
        game={game}
        rotation={rotation}
        legalMoves={[]}
        canPlay={false}
        onPlaceStone={() => {}}
      />
    </RoomBoardLayout>
  );
  return (
    <SavedMatchReplayView
      match={match}
      board={board}
      replay={replay}
      theme="gomoku"
      onRotate={rotate}
      result={<FourGomokuResult lastRound={lastRound} />}
    />
  );
}
