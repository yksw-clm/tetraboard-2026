import { gameThemes } from "../../shared/ui/appTheme";
import { gameCapacity } from "@tetraboard/protocol/games";
import { gameCatalog } from "@tetraboard/protocol/games";
import { TimeControlSetting } from "./TimeControlSetting";
import { AppRadio } from "../../shared/ui/AppRadio";
import type { ReactNode, RefObject } from "react";
import type { Room, CpuLevel, ReplayMatch } from "@tetraboard/protocol";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton } from "../../shared/ui/AppButton";
import { Accordion, Chip, Label, RadioGroup } from "@heroui/react";
import { AppButtonLink } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import { formatClock, playerName } from "./roomCommonPresentation";
import type { SharedRoomSession } from "./useRoomTransport";
import { useAccount } from "../account/useAccount";
import { CpuLevelSelector } from "./CpuLevelSelector";
import {
  isRoomSettingsUpdating,
  updatingSettingsClasses,
  updatingSettingsButtonClasses,
} from "./roomSettingsPresentation";

export function RoomInfo({
  session,
  onLeave,
  onCopyInvite,
  copying = false,
  onAddCpu,
  cpuAddButtonRef,
  canAddCpu,
  onFeedback,
  feedbackButtonRef,
  gameSettings,
}: {
  session: SharedRoomSession;
  gameSettings?: ReactNode;
  onLeave: () => void;
  onCopyInvite: () => void;
  copying?: boolean;
  onAddCpu: (level: CpuLevel) => void;
  cpuAddButtonRef: RefObject<HTMLButtonElement | null>;
  canAddCpu: boolean;
  onFeedback: () => void;
  feedbackButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { room, membership, canManageSettings } = session;
  const account = useAccount();
  const updating = isRoomSettingsUpdating(session);
  const pending = updating ? session.pendingSettingsCommand : null;
  const mode = pending?.type === "room.mode.set" ? pending.mode : room.settings.mode;
  const timeControl =
    pending?.type === "room.time-control.set" ? pending.timeControl : room.settings.timeControl;
  const canAddWhileUpdating =
    updating &&
    room.players.length < gameCapacity(room.settings.game) &&
    session.presence.hostPlayerId === membership?.playerId &&
    !account.loading &&
    !account.error;
  return (
    <RoomInfoCard roomId={room.id} settings={room.settings}>
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
        onPress={onCopyInvite}
        isDisabled={copying}
        isPending={copying}
        appearance="secondary"
      >
        <AppIcon name="copy" />
        招待リンクをコピー
      </AppButton>
      {membership === null && <p className="text-muted text-xs">観戦中です</p>}
      {room.status === "waiting" && membership?.role === "host" && (
        <Accordion className="text-xs w-full min-w-0">
          <Accordion.Item>
            <Accordion.Heading>
              <Accordion.Trigger className="w-full min-h-[38px] px-[10px] py-2 flex items-center gap-2 rounded-control border border-solid border-line bg-surface-muted text-ink-secondary font-[650] cursor-pointer hover:border-line-hover hover:bg-surface-hover focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2">
                <AppIcon name="settings" />
                <span className="flex-1 text-left">ルーム設定</span>
                <Accordion.Indicator className="shrink-0" />
              </Accordion.Trigger>
            </Accordion.Heading>
            <Accordion.Panel>
              <Accordion.Body
                className={`pt-2 px-0 pb-1 [&>div]:p-0 ${updating ? updatingSettingsClasses : ""}`}
                aria-busy={updating}
              >
                <p className="min-h-5 text-xs text-muted" role="status">
                  {updating ? "設定を更新中…" : ""}
                </p>
                {gameCatalog[room.settings.game].hasModes && (
                  <RadioGroup
                    value={mode}
                    isDisabled={!canManageSettings}
                    onChange={(value) => {
                      if (value === "singles" || value === "doubles") session.changeMode(value);
                    }}
                    orientation="horizontal"
                    className="[&_.label]:text-[11px] [&_.label]:font-bold [&_.label]:text-muted"
                  >
                    <Label>対局形式</Label>
                    <div className="flex gap-4 mt-1 mb-2 [&_.radio]:text-xs [&_.radio]:flex [&_.radio]:flex-row [&_.radio]:items-center [&_.radio]:gap-[6px]">
                      {(["singles", "doubles"] as const).map((mode) => (
                        <AppRadio key={mode} value={mode}>
                          <AppRadio.Content className="flex items-center gap-[6px]">
                            <AppRadio.Control>
                              <AppRadio.Indicator />
                            </AppRadio.Control>
                            {mode === "singles" ? "シングルス" : "ダブルス"}
                          </AppRadio.Content>
                        </AppRadio>
                      ))}
                    </div>
                  </RadioGroup>
                )}
                {gameSettings}
                <div className="mb-3">
                  <TimeControlSetting
                    timeControl={timeControl}
                    onChange={session.changeTimeControl}
                    disabled={!canManageSettings}
                    theme={gameThemes[room.settings.game]}
                  />
                </div>
                <div>
                  <p className="text-[11px] font-bold text-muted">CPUの設定</p>
                  {room.players
                    .filter((player) => player.kind === "cpu")
                    .map((cpu, index) => (
                      <div
                        key={cpu.id}
                        className="flex justify-between gap-2 items-center mt-1 [&>span]:flex-1 [&>span]:whitespace-nowrap [&_svg]:size-4 [&_svg]:mr-[5px]"
                      >
                        <span>
                          <AppIcon name="robot" />
                          CPU {index + 1}
                        </span>
                        <CpuLevelSelector
                          label={`CPU ${index + 1}のレベル`}
                          level={
                            pending?.type === "room.cpu.level.set" && pending.playerId === cpu.id
                              ? pending.level
                              : cpu.level
                          }
                          disabled={!canManageSettings}
                          updating={updating}
                          pendingLevel={
                            pending?.type === "room.cpu.level.set" && pending.playerId === cpu.id
                              ? pending.level
                              : undefined
                          }
                          onChange={(level) => session.changeCpuLevel(cpu.id, level)}
                        />
                        <AppButton
                          size="compact"
                          appearance="quiet"
                          className={`text-danger text-[11px] h-7 min-h-7 ${updating ? updatingSettingsButtonClasses : ""}`}
                          aria-label={`${playerName(cpu)}を削除`}
                          isDisabled={!canManageSettings}
                          isPending={
                            session.pendingSettingsCommand?.type === "room.cpu.remove" &&
                            session.pendingSettingsCommand.playerId === cpu.id
                          }
                          onPress={() => session.removeCpu(cpu.id)}
                        >
                          削除
                        </AppButton>
                      </div>
                    ))}
                  <div className="flex justify-end gap-2 items-center mt-2">
                    <CpuLevelSelector
                      label="追加するCPUのレベル"
                      level={session.newCpuLevel}
                      disabled={!canManageSettings}
                      updating={updating}
                      onChange={session.setNewCpuLevel}
                    />
                    <AppButton
                      ref={cpuAddButtonRef}
                      size="compact"
                      appearance="secondary"
                      className={`h-8 min-h-8 py-1 px-[10px] text-xs gap-1 ${canAddWhileUpdating ? updatingSettingsButtonClasses : ""}`}
                      isDisabled={!canAddCpu}
                      isPending={session.pendingSettingsCommand?.type === "room.cpu.add"}
                      onPress={() => onAddCpu(session.newCpuLevel)}
                    >
                      <AppIcon name="plus" className="size-4" />
                      CPUを追加
                    </AppButton>
                  </div>
                  {account.loading && !account.pendingSource && (
                    <p className="mt-2 text-xs text-muted" role="status">
                      ログイン状態を確認しています…
                    </p>
                  )}
                  {account.error && (
                    <div className="mt-2 flex flex-col items-start gap-2">
                      <p className="text-xs text-danger" role="alert">
                        {account.error}
                      </p>
                      <AppButton
                        size="compact"
                        appearance="secondary"
                        isDisabled={account.loading}
                        isPending={account.pendingSource === "room-retry"}
                        onPress={() => void account.refresh("room-retry")}
                      >
                        ログイン状態を再確認
                      </AppButton>
                    </div>
                  )}
                </div>
              </Accordion.Body>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
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
          to={gameCatalog[room.settings.game].lobbyPath}
        >
          ロビーへ戻る
        </AppButtonLink>
      )}
    </RoomInfoCard>
  );
}

export function RoomInfoCard({
  roomId,
  settings,
  children,
}: {
  roomId: string;
  settings: Room["settings"] | ReplayMatch["settings"];
  children: ReactNode;
}) {
  return (
    <AppCard
      density="compact"
      className="[&_h1]:text-base [&_h1]:font-[750] [@media(max-width:1279px)]:max-w-[720px] [@media(max-width:1279px)]:mx-auto"
    >
      <div className="flex justify-between items-center gap-3">
        <h1>ルーム情報</h1>
        <Chip
          className="bg-surface-muted text-ink-secondary text-xs font-bold tracking-[0.04em]"
          size="sm"
        >
          #{roomId}
        </Chip>
      </div>
      <dl
        className={`grid grid-cols-2 py-1 px-[10px] border border-solid rounded-[18px] [&>div]:flex [&>div]:items-center [&>div]:gap-2 [&>div]:p-1 [&>div]:min-w-0 [&>div>svg]:box-content [&>div>svg]:p-[7px] [&>div>svg]:rounded-control [&>div>svg]:text-brand [&>div>svg]:size-[18px] [&_dt]:text-muted [&_dt]:text-[10px] [&_dt]:font-[650] [&_dd]:text-xs [&_dd]:font-bold [&>div:nth-child(odd)]:border-r [&>div:nth-child(odd)]:border-solid [&>div:nth-child(odd)]:border-line [&>div:nth-child(even)]:pl-[10px] [&>div:nth-child(-n+2)]:border-b [&>div:nth-child(-n+2)]:border-solid [&>div:nth-child(-n+2)]:border-line ${settings.game === "four-shogi" ? "bg-[#fffaf0] border-[#eee4cd] [&>div>svg]:bg-[#fff0c9]" : "bg-[#f9fbf9] border-[#e8eee8] [&>div>svg]:bg-[#edf5ef]"}`}
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
      {settings.game === "four-shogi" && (
        <p className="text-xs text-muted">
          三人攻撃禁止：{settings.threePlayerAttackProhibited ? "ON" : "OFF"}
        </p>
      )}
      {children}
    </AppCard>
  );
}
