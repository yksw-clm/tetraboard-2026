import { playerAppearance } from "./roomCommonPresentation";
import type { ReplayFourReversiMatch } from "@tetraboard/protocol";
import { useBoardRotation } from "./useBoardRotation";
import { rotatedSeatIndex } from "./boardRotation";
import { RoomBoardLayout } from "./RoomLayout";
import { PlayerCard } from "./PlayerCard";
import { FourReversiBoard } from "./FourReversiBoard";
import { GameResultView } from "./GameResultView";
import { matchSeats } from "./roomPresentation";
import { seatPositions } from "./roomCommonPresentation";
import { useRoundReplay } from "./useRoomReplay";
import { SavedMatchReplayView } from "./SavedMatchReplayView";
export default function FourReversiMatchReplayView({ match }: { match: ReplayFourReversiMatch }) {
  const { rotation, rotate } = useBoardRotation();
  const lastRound = {
    game: match.game,
    players: match.participants.map((player) => ({
      ...player,
      appearance: playerAppearance(player),
    })),
    replay: match.replay,
  };
  const replay = useRoundReplay(lastRound);
  const game = replay.frame?.game ?? match.game;
  const board = (
    <RoomBoardLayout>
      {matchSeats(match).map((player, index) => (
        <PlayerCard
          key={player.id}
          profileTarget={{ source: "match", matchId: match.id, playerId: player.id }}
          player={player}
          position={seatPositions[rotatedSeatIndex(index, rotation)]}
          self={player.id === match.selfPlayerId}
          host={player.seat === 0}
          replay={{ game, eliminations: match.eliminations }}
        />
      ))}
      <FourReversiBoard
        rotation={rotation}
        game={game}
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
      onRotate={rotate}
      replay={replay}
      result={<GameResultView lastRound={lastRound} />}
    />
  );
}
