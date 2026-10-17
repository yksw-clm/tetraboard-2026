import { gameThemes } from "../../shared/ui/appTheme";
import { gameCatalog } from "@tetraboard/protocol/games";
import type { ReactNode, RefObject } from "react";
import type { Room, ReplayMatch } from "@tetraboard/protocol";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton } from "../../shared/ui/AppButton";
import { Chip } from "@heroui/react";
import { AppButtonLink } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import { formatClock } from "./roomCommonPresentation";
import type { SharedRoomSession } from "./useRoomTransport";
import { BrowserSettingsButton } from "../../shared/ui/BrowserSettings";

export function RoomInfo({
  session,
  onLeave,
  onShare,
  shareButtonRef,
  onFeedback,
  feedbackButtonRef,
  onRoomSettings,
  roomSettingsButtonRef,
  settingsOpen,
  onSettingsOpenChange,
  settingsDisabled,
}: {
  session: SharedRoomSession;
  onRoomSettings: () => void;
  roomSettingsButtonRef?: RefObject<HTMLButtonElement | null>;
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
  settingsDisabled?: boolean;
  onLeave: () => void;
  onShare: () => void;
  shareButtonRef?: RefObject<HTMLButtonElement | null>;
  onFeedback: () => void;
  feedbackButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { room, membership } = session;
  const tournamentId = "tournamentId" in room ? room.tournamentId : undefined;
  return (
    <RoomInfoCard
      roomId={room.id}
      settings={room.settings}
      settingsAction={
        <BrowserSettingsButton
          compact
          theme={gameThemes[room.settings.game]}
          isOpen={settingsOpen}
          onOpenChange={onSettingsOpenChange}
          disabled={settingsDisabled}
        />
      }
    >
      <AppButton
        appearance="secondary"
        size="compact"
        className="w-full"
        onPress={onFeedback}
        ref={feedbackButtonRef}
      >
        不具合・ご意見
      </AppButton>
      <AppButton
        size="compact"
        className="w-full"
        onPress={onShare}
        ref={shareButtonRef}
        appearance="secondary"
      >
        <AppIcon name="copy" />
        ルームを共有
      </AppButton>
      {membership === null && <p className="text-muted text-xs">観戦中です</p>}
      {tournamentId === undefined && room.status === "waiting" && membership?.role === "host" && (
        <AppButton
          appearance="secondary"
          size="compact"
          className="w-full bg-surface-muted"
          ref={roomSettingsButtonRef}
          onPress={onRoomSettings}
          isDisabled={settingsDisabled || !session.canManageSettings}
          aria-haspopup="dialog"
        >
          <AppIcon name="settings" />
          ルーム設定
        </AppButton>
      )}
      {membership ? (
        <AppButton
          size="compact"
          className="w-full"
          isDisabled={session.leaving}
          isPending={session.leaving}
          onPress={onLeave}
          appearance="danger"
        >
          <AppIcon name="leave" />
          退室
        </AppButton>
      ) : (
        <AppButtonLink
          size="compact"
          className="w-full"
          to={
            tournamentId !== undefined
              ? `/tournaments/${tournamentId}`
              : gameCatalog[room.settings.game].lobbyPath
          }
        >
          {tournamentId !== undefined ? "大会へ戻る" : "ロビーへ戻る"}
        </AppButtonLink>
      )}
    </RoomInfoCard>
  );
}

export function RoomInfoCard({
  roomId,
  settings,
  children,
  settingsAction,
}: {
  roomId: string;
  settings: Room["settings"] | ReplayMatch["settings"];
  children: ReactNode;
  settingsAction?: ReactNode;
}) {
  return (
    <AppCard
      density="compact"
      className="[&_h1]:text-base [&_h1]:font-[750] [@media(max-width:1279px)]:max-w-[720px] [@media(max-width:1279px)]:mx-auto"
    >
      <div className="flex justify-between items-center gap-3">
        <h1>ルーム情報</h1>
        <div className="flex items-center gap-2">
          <Chip
            className="bg-surface-muted text-ink-secondary text-xs font-bold tracking-[0.04em]"
            size="sm"
          >
            #{roomId}
          </Chip>
          {settingsAction ?? <BrowserSettingsButton compact theme={gameThemes[settings.game]} />}
        </div>
      </div>
      <dl
        className={`grid grid-cols-2 py-1 px-[10px] border border-solid rounded-[18px] [&>div]:flex [&>div]:items-center [&>div]:gap-2 [&>div]:p-1 [&>div]:min-w-0 [&>div>svg]:box-content [&>div>svg]:p-[7px] [&>div>svg]:rounded-control [&>div>svg]:text-brand [&>div>svg]:size-[18px] [&_dt]:text-muted [&_dt]:text-[10px] [&_dt]:font-[650] [&_dd]:text-xs [&_dd]:font-bold [&>div:nth-child(odd)]:border-r [&>div:nth-child(odd)]:border-solid [&>div:nth-child(odd)]:border-line [&>div:nth-child(even)]:pl-[10px] [&>div:nth-child(-n+2)]:border-b [&>div:nth-child(-n+2)]:border-solid [&>div:nth-child(-n+2)]:border-line ${settings.game === "gomoku" || settings.game === "four-gomoku" ? "bg-surface-muted border-line [&>div>svg]:bg-surface-hover" : settings.game === "four-shogi" ? "bg-[#fffaf0] border-[#eee4cd] [&>div>svg]:bg-[#fff0c9]" : "bg-[#f9fbf9] border-[#e8eee8] [&>div>svg]:bg-[#edf5ef]"}`}
      >
        <div>
          <AppIcon name="board" />
          <div>
            <dt>ゲーム名</dt>
            <dd>{gameCatalog[settings.game].name}</dd>
          </div>
        </div>
        {gameCatalog[settings.game].hasModes && (
          <div>
            <AppIcon name="user" />
            <div>
              <dt>対局形式</dt>
              <dd>{settings.mode === "singles" ? "シングルス" : "ダブルス"}</dd>
            </div>
          </div>
        )}
        <div>
          <AppIcon name="clock" />
          <div>
            <dt>持ち時間</dt>
            <dd>
              {settings.timeControl === null
                ? "不明"
                : settings.timeControl.mainTimeMs === 0
                  ? "なし"
                  : formatClock(settings.timeControl.mainTimeMs)}
            </dd>
          </div>
        </div>
        <div>
          <AppIcon name="clock" />
          <div>
            <dt>秒読み</dt>
            <dd>
              {settings.timeControl === null
                ? "不明"
                : settings.timeControl.byoyomiMs === 0
                  ? "なし"
                  : formatClock(settings.timeControl.byoyomiMs)}
            </dd>
          </div>
        </div>
      </dl>
      {settings.game === "gomoku" && (
        <p className="text-xs text-muted">禁手ルール：{settings.forbiddenRules ? "ON" : "OFF"}</p>
      )}
      {settings.game === "four-shogi" && (
        <p className="text-xs text-muted">
          三人攻撃禁止：{settings.threePlayerAttackProhibited ? "ON" : "OFF"}
        </p>
      )}
      {children}
    </AppCard>
  );
}
