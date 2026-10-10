import { gameCatalog } from "@tetraboard/protocol/games";
import type { ReplayMatch } from "@tetraboard/protocol";
import { useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useRoomDesktop } from "./useRoomDesktop";
import { ViewerControls } from "./ViewerControls";
import { ReplayCard } from "./ReplayCard";
import { RoomLayout } from "./RoomLayout";
import { RoomInfoCard } from "./RoomInfo";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppDialog } from "../../shared/ui/AppDialog";
import { appThemeClasses, type AppTheme } from "../../shared/ui/appTheme";
export function SavedMatchReplayView({
  match,
  board,
  replay,
  result,
  theme = "default",
  onRotate,
}: {
  match: ReplayMatch;
  board: ReactNode;
  replay: {
    frames: readonly { label: string; accessibleLabel?: string }[];
    index: number;
    select: (index: number) => void;
  };
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
      <AppButtonLink
        size="compact"
        className="w-full"
        to={match.selfPlayerId ? "/account" : gameCatalog[match.settings.game].lobbyPath}
        state={location.state}
      >
        {match.selfPlayerId ? "マイページへ戻る" : "ロビーへ戻る"}
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
      <ViewerControls
        label="棋譜閲覧中"
        onRotate={onRotate}
        rotationDegrees={!gameCatalog[match.settings.game].hasModes ? 180 : 90}
      />
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
