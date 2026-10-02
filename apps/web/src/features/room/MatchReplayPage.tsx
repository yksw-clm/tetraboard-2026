import { useRoomDesktop } from "./useRoomDesktop";
import { type MatchDetail } from "@tetraboard/protocol";
import { useState } from "react";
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
import { PlayerCard } from "./PlayerCard";
import { ReplayCard } from "./ReplayCard";
import { RoomBoardLayout, RoomLayout } from "./RoomLayout";
import { RoomInfoCard } from "./RoomInfo";
import { matchSeats, seatPositions } from "./roomPresentation";
import { useRoundReplay } from "./useRoomReplay";

export function MatchReplayPage() {
  const match = useLoaderData<MatchDetail>();
  return <MatchReplayView key={match.id} match={match} />;
}

function MatchReplayView({ match }: { match: MatchDetail }) {
  const desktop = useRoomDesktop();
  const [tab, setTab] = useState("board");
  const [results, setResults] = useState(false);
  const lastRound = { game: match.game, players: match.participants, replay: match.replay };
  const replay = useRoundReplay(lastRound);
  const game = replay.frame?.game ?? match.game;
  const replayCard = <ReplayCard replay={replay} />;
  const board = (
    <RoomBoardLayout>
      {matchSeats(match).map((player, index) => (
        <PlayerCard
          key={player.id}
          player={player}
          position={seatPositions[index]}
          self={player.id === match.selfPlayerId}
          host={player.seat === 0}
          replay={{ game, eliminations: match.eliminations }}
        />
      ))}
      <FourReversiBoard game={game} legalMoves={[]} canPlay={false} onPlaceStone={() => {}} />
    </RoomBoardLayout>
  );
  const info = (
    <RoomInfoCard roomId={match.roomId} settings={match.settings}>
      <p className="text-muted text-xs">棋譜を閲覧中です。</p>
      <AppButtonLink size="compact" className="w-full" to="/account">
        マイページへ戻る
      </AppButtonLink>
    </RoomInfoCard>
  );
  const status = (
    <AppCard
      density="compact"
      aria-label="対局状況"
      className="min-h-[88px] flex items-center justify-center shrink-0 [@media(min-width:1280px)]:col-start-2 [@media(min-width:1280px)]:row-start-2 [@media(max-width:1279px)]:col-start-1 [@media(max-width:1279px)]:row-start-2 [@media(max-width:767px)]:mx-[2px] [@media(max-width:767px)]:h-[92px]"
    >
      <div className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 [@media(max-width:767px)]:gap-1">
        <strong className="text-sm whitespace-nowrap [@media(max-width:767px)]:text-xs">
          対局終了
        </strong>
        {desktop ? <span /> : replayCard}
        <AppButton
          size="compact"
          appearance="quiet"
          className="text-brand bg-[#e9f4ec] h-7 min-h-7 px-[6px] text-xs"
          onPress={() => setResults(true)}
        >
          結果
        </AppButton>
      </div>
    </AppCard>
  );
  return (
    <main className="app-theme room-background flex flex-col h-dvh overflow-hidden text-ink text-sm leading-normal">
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
        <AppDialog size="compact" title="対局結果" onClose={() => setResults(false)}>
          <GameResultView lastRound={lastRound} />
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
            });
          }}
        >
          再試行
        </AppButton>
      )}
      <AppButtonLink size="compact" to="/account">
        マイページへ戻る
      </AppButtonLink>
    </main>
  );
}
