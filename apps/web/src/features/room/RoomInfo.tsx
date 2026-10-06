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

export function RoomInfo({
  session,
  onLeave,
  onCopyInvite,
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
  onAddCpu: (level: CpuLevel) => void;
  cpuAddButtonRef: RefObject<HTMLButtonElement | null>;
  canAddCpu: boolean;
  onFeedback: () => void;
  feedbackButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { room, membership, canManageSettings } = session;
  const account = useAccount();
  return (
    <RoomInfoCard roomId={room.id} settings={room.settings}>
      <AppButton appearance="quiet" size="compact" onPress={onFeedback} ref={feedbackButtonRef}>
        不具合・ご意見
      </AppButton>
      <AppButton size="compact" className="w-full" onPress={onCopyInvite} appearance="secondary">
        <AppIcon name="copy" />
        招待リンクをコピー
      </AppButton>
      {membership === null && <p className="text-muted text-xs">観戦中です</p>}
      {room.status === "waiting" && membership?.role === "host" && (
        <Accordion className="text-xs">
          <Accordion.Item>
            <Accordion.Heading>
              <Accordion.Trigger className="py-2 px-0 font-[650] gap-2 min-h-9 border-0 bg-transparent cursor-pointer">
                <AppIcon name="settings" />
                ルーム設定
                <Accordion.Indicator />
              </Accordion.Trigger>
            </Accordion.Heading>
            <Accordion.Panel>
              <Accordion.Body className="pt-[2px] px-0 pb-1 [&>div]:p-0">
                <RadioGroup
                  value={room.settings.mode}
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
                {gameSettings}
                <div className="mb-3">
                  <TimeControlSetting
                    timeControl={room.settings.timeControl}
                    onChange={session.changeTimeControl}
                    disabled={!canManageSettings}
                    theme={room.settings.game === "four-shogi" ? "four-shogi" : "default"}
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
                        <div
                          className="flex rounded-lg bg-surface-muted p-[2px]"
                          role="group"
                          aria-label={`CPU ${index + 1}のレベル`}
                        >
                          {([1, 2] as const).map((level) => (
                            <AppButton
                              key={level}
                              size="compact"
                              className="text-[11px] h-6 min-h-6 min-w-[38px] bg-transparent rounded-[6px] py-[2px] px-2 text-muted aria-pressed:bg-white aria-pressed:shadow-[0_1px_4px_#2138271a] aria-pressed:text-brand"
                              aria-pressed={cpu.level === level}
                              isDisabled={!canManageSettings}
                              onPress={() => session.changeCpuLevel(cpu.id, level)}
                            >
                              Lv{level}
                            </AppButton>
                          ))}
                        </div>
                        <AppButton
                          size="compact"
                          appearance="quiet"
                          className="text-danger text-[11px] h-7 min-h-7"
                          aria-label={`${playerName(cpu)}を削除`}
                          isDisabled={!canManageSettings}
                          onPress={() => session.removeCpu(cpu.id)}
                        >
                          削除
                        </AppButton>
                      </div>
                    ))}
                  <div className="flex justify-between gap-2 items-center mt-1">
                    <div
                      className="flex rounded-lg bg-surface-muted p-[2px]"
                      role="group"
                      aria-label="追加するCPUのレベル"
                    >
                      {([1, 2] as const).map((level) => (
                        <AppButton
                          key={level}
                          size="compact"
                          className="text-[11px] h-6 min-h-6 min-w-[38px] bg-transparent rounded-[6px] py-[2px] px-2 text-muted aria-pressed:bg-white aria-pressed:shadow-[0_1px_4px_#2138271a] aria-pressed:text-brand"
                          aria-pressed={session.newCpuLevel === level}
                          isDisabled={!canManageSettings}
                          onPress={() => session.setNewCpuLevel(level)}
                        >
                          Lv{level}
                        </AppButton>
                      ))}
                    </div>
                    <AppButton
                      ref={cpuAddButtonRef}
                      size="compact"
                      appearance="secondary"
                      isDisabled={!canAddCpu}
                      onPress={() => onAddCpu(session.newCpuLevel)}
                    >
                      <AppIcon name="plus" />
                      CPUを追加
                    </AppButton>
                  </div>
                  {account.loading && (
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
                        onPress={() => void account.refresh()}
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
          onPress={onLeave}
          appearance="danger"
        >
          <AppIcon name="leave" />
          {session.leaving ? "退室中…" : "退室"}
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
        <div>
          <AppIcon name="user" />
          <div>
            <dt>対局形式</dt>
            <dd>{settings.mode === "singles" ? "シングルス" : "ダブルス"}</dd>
          </div>
        </div>
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
