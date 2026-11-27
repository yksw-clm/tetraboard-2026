import { gameCatalog, gameNameWithAlias } from "@tetraboard/protocol/games";
import type { ReplayMatch } from "@tetraboard/protocol";
import { useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useRoomDesktop, useRoomMobile } from "./useRoomDesktop";
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
  const mobile = useRoomMobile();
  const location = useLocation();
  const [tab, setTab] = useState("board");
  const [results, setResults] = useState(false);
  const game = match.settings.game;
  const { name, lobbyPath, hasModes } = gameCatalog[game];
  const title = gameNameWithAlias(game);
  const info = (
    <RoomInfoCard roomId={match.roomId} settings={match.settings}>
      <AppButtonLink
        size="compact"
        className="w-full"
        to={match.selfPlayerId ? "/account" : lobbyPath}
        state={location.state}
      >
        {match.selfPlayerId ? "マイページへ戻る" : "ロビーへ戻る"}
      </AppButtonLink>
    </RoomInfoCard>
  );
  const status = (
    <RoomStatusCard>
      {!desktop && (
        <div className="min-w-0 flex-1">
          <ReplayCard replay={replay} theme={theme} placement={mobile ? "status" : "board"} />
        </div>
      )}
      <AppButton
        size="compact"
        appearance="secondary"
        className="[@media(max-width:767px)]:min-w-16 [@media(min-width:1280px)]:min-w-16"
        onPress={() => setResults(true)}
      >
        結果
      </AppButton>
      <ViewerControls
        label="棋譜閲覧中"
        matchKind={match.matchKind ?? "unknown"}
        hideLabelOnMobile
        onRotate={onRotate}
        rotationDegrees={!hasModes ? 180 : 90}
      />
    </RoomStatusCard>
  );
  return (
    <main
      className={`app-theme ${appThemeClasses[theme]} room-background flex flex-col h-dvh overflow-hidden text-ink text-sm leading-normal`}
    >
      <section
        aria-label={match.selfPlayerId ? "棋譜の操作" : "このゲームを遊ぶ"}
        className="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 border-b border-solid border-line bg-surface-muted px-3 py-1.5"
      >
        {!match.selfPlayerId && (
          <>
            <p className="min-w-32 flex-1 text-xs">
              {title}は登録なしで、ブラウザからすぐ遊べます。
            </p>
            <AppButtonLink appearance="primary" size="compact" to={lobbyPath}>
              {name}を遊ぶ
            </AppButtonLink>
          </>
        )}
        <AppButtonLink
          appearance="secondary"
          size="compact"
          to={`/games/${game}/posts?match=${match.id}&position=${replay.index}`}
        >
          この局面で投稿する
        </AppButtonLink>
      </section>
      <RoomLayout
        statusBelowBoard
        desktop={desktop}
        tab={tab}
        onTabChange={setTab}
        board={board}
        info={info}
        status={status}
        replay={desktop ? <ReplayCard replay={replay} theme={theme} placement="footer" /> : null}
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
