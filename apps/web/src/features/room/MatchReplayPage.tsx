import { ShogiSideBadge } from "./FourShogiPlayerCard";
import { FeedbackEntry } from "../feedback/FeedbackEntry";
import { ViewerControls } from "./ViewerControls";
import { useBoardRotation } from "./useBoardRotation";
import { rotatedSeatIndex, rotatedShogiViewer } from "./boardRotation";
import { useRoomDesktop } from "./useRoomDesktop";
import {
  isFourShogiMatch,
  type MatchDetail,
  type FourReversiMatchDetail,
  type FourShogiMatchDetail,
} from "@tetraboard/protocol";
import { useState, type ReactNode } from "react";
import { sides, type Side } from "@tetraboard/four-shogi";
import {
  isRouteErrorResponse,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
  useRouteError,
} from "react-router";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppDialog } from "../../shared/ui/AppDialog";
import { FourReversiBoard } from "./FourReversiBoard";
import { GameResultView } from "./GameResultView";
import { PlayerCard, PlayerCardView } from "./PlayerCard";
import { ReplayCard } from "./ReplayCard";
import { RoomBoardLayout, RoomLayout } from "./RoomLayout";
import { RoomInfoCard } from "./RoomInfo";
import { matchSeats, seatPositions } from "./roomPresentation";
import { useRoundReplay } from "./useRoomReplay";
import { FourShogiBoardLayout } from "./FourShogiBoardLayout";
import { FourShogiGameResultView } from "./FourShogiGameResultView";
import { shogiCardPosition, shogiPlayerRank } from "./fourShogiRoomPresentation";
import { appThemeClasses, type AppTheme } from "../../shared/ui/appTheme";
import { type FourShogiReplayFrame } from "./fourShogiReplay";
import { type MatchReplayData } from "./matchReplayLoader";

export function MatchReplayPage() {
  const { match, shogiFrames } = useLoaderData<MatchReplayData>();
  return isFourShogiMatch(match) ? (
    <FourShogiMatchReplayView key={match.id} match={match} frames={shogiFrames!} />
  ) : (
    <FourReversiMatchReplayView key={match.id} match={match} />
  );
}

function FourReversiMatchReplayView({ match }: { match: FourReversiMatchDetail }) {
  const { rotation, rotate } = useBoardRotation();
  const lastRound = { game: match.game, players: match.participants, replay: match.replay };
  const replay = useRoundReplay(lastRound);
  const game = replay.frame?.game ?? match.game;
  const board = (
    <RoomBoardLayout>
      {matchSeats(match).map((player, index) => (
        <PlayerCard
          key={player.id}
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

function FourShogiMatchReplayView({
  match,
  frames,
}: {
  match: FourShogiMatchDetail;
  frames: FourShogiReplayFrame[];
}) {
  const { rotation, rotate } = useBoardRotation();
  const [index, setIndex] = useState(frames.length - 1);
  const frame = frames[index]!;
  const viewerSide = rotatedShogiViewer(
    match.participants.find((player) => player.id === match.selfPlayerId)!.side,
    rotation,
  );
  const cards = Object.fromEntries(
    sides.map((side) => {
      const player = match.participants.find((entry) => entry.side === side)!;
      return [
        side,
        <PlayerCardView
          key={player.id}
          shogi
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
        />,
      ];
    }),
  ) as Record<Side, ReactNode>;
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
    players: match.participants,
    eventCount: match.replay.eventCount,
  };
  return (
    <SavedMatchReplayView
      match={match}
      board={board}
      onRotate={rotate}
      replay={replay}
      theme="four-shogi"
      result={<FourShogiGameResultView lastRound={lastRound} />}
    />
  );
}

function SavedMatchReplayView({
  match,
  board,
  replay,
  result,
  theme = "default",
  onRotate,
}: {
  match: MatchDetail;
  board: ReactNode;
  replay: { frames: readonly { label: string }[]; index: number; select: (index: number) => void };
  result: ReactNode;
  theme?: AppTheme;
  onRotate: () => void;
}) {
  const desktop = useRoomDesktop();
  const location = useLocation();
  const [tab, setTab] = useState("board");
  const [results, setResults] = useState(false);
  const replayCard = <ReplayCard replay={replay} theme={theme} />;
  const info = (
    <RoomInfoCard roomId={match.roomId} settings={match.settings}>
      <AppButtonLink size="compact" className="w-full" to="/account" state={location.state}>
        マイページへ戻る
      </AppButtonLink>
    </RoomInfoCard>
  );
  const status = (
    <AppCard
      density="compact"
      aria-label="対局状況"
      className="min-h-[88px] flex flex-col gap-2 items-center justify-center shrink-0 [@media(min-width:1280px)]:col-start-2 [@media(min-width:1280px)]:row-start-2 [@media(max-width:1279px)]:col-start-1 [@media(max-width:1279px)]:row-start-2 [@media(max-width:767px)]:mx-[2px] [@media(max-width:767px)]:h-[92px] [@media(max-width:767px)]:py-2"
    >
      <div className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 [@media(max-width:767px)]:gap-1">
        <strong className="text-sm whitespace-nowrap [@media(max-width:767px)]:text-xs">
          対局終了
        </strong>
        {desktop ? <span /> : replayCard}
        <AppButton
          size="compact"
          appearance="quiet"
          className={`text-brand ${theme === "four-shogi" ? "bg-[#fff0c9]" : "bg-[#e9f4ec]"} h-7 min-h-7 px-[6px] text-xs`}
          onPress={() => setResults(true)}
        >
          結果
        </AppButton>
      </div>
      <ViewerControls label="棋譜閲覧中" onRotate={onRotate} />
    </AppCard>
  );
  return (
    <main
      className={`app-theme ${appThemeClasses[theme]} room-background flex flex-col h-dvh overflow-hidden text-ink text-sm leading-normal`}
    >
      <RoomLayout
        desktop={desktop}
        tab={tab}
        onTabChange={setTab}
        board={board}
        info={info}
        status={status}
        replay={replayCard}
        showChatTab={false}
        chat={
          <AppCard className="h-full">
            <h2 className="text-sm font-bold">チャット</h2>
            <p className="text-muted text-xs">棋譜閲覧ではチャットを利用できません。</p>
          </AppCard>
        }
      />
      {results && (
        <AppDialog size="compact" title="対局結果" onClose={() => setResults(false)} theme={theme}>
          {result}
        </AppDialog>
      )}
    </main>
  );
}

export function MatchReplayErrorPage() {
  const error = useRouteError();
  const navigate = useNavigate();
  const location = useLocation();
  const navigation = useNavigation();
  const status = isRouteErrorResponse(error) ? error.status : 503;
  const retryable = status !== 400 && status !== 404;
  return (
    <main className="app-theme room-background flex flex-col h-dvh items-center justify-center gap-4 p-6 text-sm">
      <p role="alert">
        {status === 400
          ? "棋譜のURLが正しくありません。"
          : status === 404
            ? "この棋譜は閲覧できません。"
            : "棋譜を取得できませんでした。もう一度お試しください。"}
      </p>
      {retryable && (
        <AppButton
          size="compact"
          isDisabled={navigation.state === "loading"}
          onPress={() => {
            // 同じURLでも遷移を行い、成功時にルーターのエラー境界を解除します。
            void navigate(`${location.pathname}${location.search}${location.hash}`, {
              replace: true,
              state: location.state,
            });
          }}
        >
          再試行
        </AppButton>
      )}
      <AppButtonLink size="compact" to="/account" state={location.state}>
        マイページへ戻る
      </AppButtonLink>
      <FeedbackEntry context={{ page: "error", game: "all" }} />
    </main>
  );
}
