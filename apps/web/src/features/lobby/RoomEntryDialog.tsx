import { publicRecordNotice } from "@tetraboard/protocol/privacy";
import { LegalNotice } from "../privacy/LegalNotice";
import { PrivacyLinks } from "../privacy/PrivacyLinks";
import { GomokuForbiddenControl } from "./GomokuForbiddenControl";
import { gameCatalog } from "@tetraboard/protocol/games";
import { defaultGameId, type GameId } from "@tetraboard/protocol/games";
import { TimeControlSetting } from "../room/TimeControlSetting";
import { AppRadio } from "../../shared/ui/AppRadio";
import { RoomIdentityFields } from "../account/RoomIdentityFields";
import { CpuMatchNotice } from "../account/CpuMatchNotice";
import { useAccount } from "../account/useAccount";
import { Label, RadioGroup } from "@heroui/react";
import { AppButton } from "../../shared/ui/AppButton";
import { AppTextField } from "../../shared/ui/AppTextField";
import { type RoomTimeControl, type RoomMode, type CpuLevel } from "@tetraboard/protocol";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppIcon } from "../../shared/ui/AppIcon";
import { type RoomEntryIntent } from "./useRoomEntry";
import { type AppTheme } from "../../shared/ui/appTheme";
import { RoomModeSetting } from "./RoomModeSetting";
import { ThreePlayerAttackSetting } from "./ThreePlayerAttackSetting";

export function RoomEntryDialog({
  game = defaultGameId,
  intent,
  selectedRoomId,
  name,
  roomCode,
  mode,
  cpuLevel,
  onCpuLevelChange,
  timeControl,
  onTimeControlChange,
  forbiddenRules,
  onForbiddenRulesChange,
  threePlayerAttackProhibited,
  busy,
  message,
  theme = "default",
  unavailable = false,
  onNameChange,
  onRoomCodeChange,
  onModeChange,
  onThreePlayerAttackChange,
  onSubmit,
  onClose,
}: {
  game?: GameId;
  intent: RoomEntryIntent;
  selectedRoomId?: string;
  name: string;
  roomCode: string;
  mode: RoomMode;
  cpuLevel: CpuLevel;
  onCpuLevelChange: (level: CpuLevel) => void;
  timeControl: RoomTimeControl;
  onTimeControlChange: (value: RoomTimeControl) => void;
  threePlayerAttackProhibited?: boolean;
  forbiddenRules?: boolean;
  onForbiddenRulesChange?: (enabled: boolean) => void;
  busy: boolean;
  message: string | null;
  theme?: AppTheme;
  unavailable?: boolean;
  onNameChange: (value: string) => void;
  onRoomCodeChange: (value: string) => void;
  onModeChange: (mode: RoomMode) => void;
  onThreePlayerAttackChange?: (prohibited: boolean) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const account = useAccount();
  const blocked = unavailable || busy || account.loading || Boolean(account.error);
  const title =
    intent === "quick"
      ? "CPUと遊ぶ"
      : intent === "create"
        ? "ルームを作る"
        : selectedRoomId
          ? `ルーム ${selectedRoomId} に参加`
          : "ルーム番号で参加";

  return (
    <AppDialog title={title} busy={busy} onClose={onClose} theme={theme}>
      <p className="text-muted text-[13px] leading-[1.8]">
        {unavailable
          ? "四人将棋のオンライン対局は準備中です。入力項目は確認できますが、まだルームの作成・参加はできません。"
          : intent === "quick"
            ? !gameCatalog[game].hasModes
              ? "CPUと対戦。待機室で「対局開始」を押すと始まります。"
              : "CPU3人と対戦。待機室で「対局開始」を押すと始まります。"
            : intent === "create"
              ? "ルームを作って、招待URLを友達に共有しましょう。公開ルーム一覧からも参加できます。"
              : account.user
                ? "アカウントのプロフィールで参加します。"
                : "対局で使うニックネームを入力してください。"}
      </p>
      {intent === "quick" && account.user && (
        <div className="mt-3">
          <CpuMatchNotice />
        </div>
      )}
      <form
        className="flex flex-col gap-[22px] mt-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!blocked) onSubmit();
        }}
      >
        <p className="text-sm text-muted">
          {publicRecordNotice} 本名・連絡先は名前に入力しないでください。
        </p>
        <RoomIdentityFields name={name} onChange={onNameChange} busy={busy} id="nickname" />

        {intent === "join" ? (
          selectedRoomId ? (
            <p className="py-[13px] px-4 rounded-control text-muted bg-entry-room-surface text-[13px] [&_strong]:ml-3 [&_strong]:text-ink [&_strong]:text-[17px] [&_strong]:tabular-nums [&_strong]:tracking-[0.08em]">
              参加するルーム <strong>{selectedRoomId}</strong>
            </p>
          ) : (
            <AppTextField value={roomCode} onChange={onRoomCodeChange} isDisabled={busy}>
              <AppTextField.Label>ルーム番号</AppTextField.Label>
              <AppTextField.Input
                id="room-code"
                className="tabular-nums tracking-[0.2em]"
                inputMode="numeric"
                autoComplete="off"
                placeholder="12345"
              />
              <AppTextField.Description>友達から教えてもらった5桁の番号</AppTextField.Description>
            </AppTextField>
          )
        ) : (
          <>
            {intent === "quick" && (
              <RadioGroup
                className="min-w-0 m-0 p-0 border-0 flex-col! gap-[10px]! [&>.label]:text-[13px] [&>.label]:font-[650] [&>.label]:mb-0 [&>.label]:p-0"
                name="cpu-level"
                value={String(cpuLevel)}
                onChange={(value) => {
                  if (value === "1" || value === "2") onCpuLevelChange(value === "1" ? 1 : 2);
                }}
                isDisabled={busy}
                orientation="horizontal"
              >
                <Label>CPUレベル</Label>
                <div className="grid grid-cols-2 gap-[10px] [@media(max-width:400px)]:grid-cols-1 [&_.radio]:min-w-0">
                  {([1, 2] as const).map((level) => (
                    <AppRadio key={level} value={String(level)}>
                      <AppRadio.Content className="flex items-center gap-[9px] py-[13px] px-3 border border-solid border-line rounded-[11px] cursor-pointer font-normal w-full data-[selected=true]:border-entry-selection-line data-[selected=true]:bg-entry-selection-surface">
                        <AppRadio.Control>
                          <AppRadio.Indicator />
                        </AppRadio.Control>
                        <span className="text-[13px] font-[650]">
                          Lv{level}（{level === 1 ? "よわい" : "ふつう"}）
                        </span>
                      </AppRadio.Content>
                    </AppRadio>
                  ))}
                </div>
              </RadioGroup>
            )}
            {gameCatalog[game].hasModes && (
              <RoomModeSetting mode={mode} onChange={onModeChange} disabled={busy} />
            )}
            {forbiddenRules !== undefined && onForbiddenRulesChange && (
              <GomokuForbiddenControl
                enabled={forbiddenRules}
                disabled={busy}
                onChange={onForbiddenRulesChange}
              />
            )}
            {threePlayerAttackProhibited !== undefined && onThreePlayerAttackChange && (
              <ThreePlayerAttackSetting
                prohibited={threePlayerAttackProhibited}
                disabled={busy}
                onChange={onThreePlayerAttackChange}
              />
            )}
            <TimeControlSetting
              timeControl={timeControl}
              onChange={onTimeControlChange}
              disabled={busy}
              theme={theme}
            />
          </>
        )}
        {message && (
          <p
            className="mb-0 py-[13px] px-4 border border-solid border-[#efd9d2] rounded-[11px] text-[#98472f] bg-[#fdf4f0] text-[13px] wrap-anywhere"
            role="alert"
          >
            {message}
          </p>
        )}
        <LegalNotice />
        <AppButton type="submit" className="w-full min-h-12" isDisabled={blocked} isPending={busy}>
          {unavailable
            ? "準備中"
            : intent === "join"
              ? "参加する"
              : intent === "quick"
                ? "CPUとの待機室へ"
                : "ルームを作る"}
          {!unavailable && <AppIcon name="arrow" />}
        </AppButton>
        <PrivacyLinks newTab />
      </form>
    </AppDialog>
  );
}
