import { gameCatalog } from "@tetraboard/protocol/games";
import type { ReplayMatch } from "@tetraboard/protocol";
import { useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useRoomDesktop } from "./useRoomDesktop";
import { ViewerControls } from "./ViewerControls";
import { ReplayCard } from "./ReplayCard";
import { RoomLayout } from "./RoomLayout";
import { RoomStatusCard } from "./RoomStatusCard";
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
  const replayCard = <ReplayCard replay={replay} theme={theme} compactMobile />;
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
    <RoomStatusCard>
      <strong className={desktop ? "text-sm whitespace-nowrap" : "sr-only"}>対局終了</strong>
      {!desktop && <div className="min-w-0 flex-1">{replayCard}</div>}
      <AppButton size="compact" appearance="secondary" onPress={() => setResults(true)}>
        結果
      </AppButton>
      <ViewerControls
        label="棋譜閲覧中"
        onRotate={onRotate}
        rotationDegrees={!gameCatalog[match.settings.game].hasModes ? 180 : 90}
      />
    </RoomStatusCard>
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
