import { defaultGameId, type GameId } from "@tetraboard/protocol/games";
import { TimeControlSetting } from "../room/TimeControlSetting";
import { AppRadio } from "../../shared/ui/AppRadio";
import { RoomIdentityFields } from "../account/RoomIdentityFields";
import { CpuMatchNotice } from "../account/CpuMatchNotice";
import { useAccount } from "../account/useAccount";
import { Label, RadioGroup } from "@heroui/react";
import { AppButton } from "../../shared/ui/AppButton";
import { AppTextField } from "../../shared/ui/AppTextField";
import { type RoomTimeControl, type RoomMode } from "@tetraboard/protocol";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppIcon } from "../../shared/ui/AppIcon";
import { type RoomEntryIntent } from "./useRoomEntry";
import { type AppTheme } from "../../shared/ui/appTheme";
import { ThreePlayerAttackSetting } from "./ThreePlayerAttackSetting";
import { useSocialSignIn } from "../account/useSocialSignIn";

export function RoomEntryDialog({
  game = defaultGameId,
  intent,
  selectedRoomId,
  name,
  roomCode,
  mode,
  timeControl,
  onTimeControlChange,
  threePlayerAttackProhibited,
  busy: entryBusy,
  message,
  theme = "default",
  unavailable = false,
  onNameChange,
  onRoomCodeChange,
  onModeChange,
  onThreePlayerAttackChange,
  onSubmit,
  onClose,
  registrationPath,
  humanOnly,
}: {
  game?: GameId;
  intent: RoomEntryIntent;
  selectedRoomId?: string;
  name: string;
  roomCode: string;
  mode: RoomMode;
  timeControl: RoomTimeControl;
  onTimeControlChange: (value: RoomTimeControl) => void;
  threePlayerAttackProhibited?: boolean;
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
  registrationPath: string;
  humanOnly?: boolean;
}) {
  const account = useAccount();
  const signIn = useSocialSignIn();
  const busy = entryBusy || signIn.busy;
  const blocked = unavailable || busy || account.loading || Boolean(account.error);
  const title =
    intent === "quick"
      ? "すぐ遊ぶ"
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
            ? "CPU3人と対戦。待機室で「対局開始」を押すと始まります。"
            : intent === "create"
              ? "ルームを作って、URLやルーム番号で友達を招待しましょう。"
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
        <RoomIdentityFields
          name={name}
          onChange={onNameChange}
          busy={busy}
          id="nickname"
          registration={{
            game,
            pendingProvider: signIn.pendingProvider,
            humanOnly: intent !== "quick" && (humanOnly ?? true),
            onRegister: (provider) =>
              void signIn.start(provider, {
                path: registrationPath,
                entry: {
                  intent,
                  name,
                  roomCode,
                  mode,
                  timeControl,
                  selectedRoomId,
                  humanOnly,
                  threePlayerAttackProhibited,
                },
              }),
          }}
        />
        {signIn.message && (
          <p role="alert" className="text-sm text-danger">
            {signIn.message}
          </p>
        )}
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
            <RadioGroup
              className="min-w-0 m-0 p-0 border-0 flex-col! gap-[10px]! [&>.label]:text-[13px] [&>.label]:font-[650] [&>.label]:mb-0 [&>.label]:p-0"
              name="mode"
              value={mode}
              onChange={(value) => {
                if (value === "singles" || value === "doubles") onModeChange(value);
              }}
              isDisabled={busy}
              orientation="horizontal"
            >
              <Label>対局モード</Label>
              <div className="grid grid-cols-2 gap-[10px] [@media(max-width:400px)]:grid-cols-1 [&_.radio]:min-w-0">
                {(["singles", "doubles"] as const).map((option) => (
                  <AppRadio key={option} value={option}>
                    <AppRadio.Content className="flex items-center gap-[9px] py-[13px] px-3 border border-solid border-line rounded-[11px] cursor-pointer font-normal w-full data-[selected=true]:border-entry-selection-line data-[selected=true]:bg-entry-selection-surface [&_strong]:block [&_strong]:text-[13px] [&_small]:block [&_small]:mt-[3px] [&_small]:text-muted [&_small]:text-[11px]">
                      <AppRadio.Control>
                        <AppRadio.Indicator />
                      </AppRadio.Control>
                      <span>
                        <strong>{option === "singles" ? "シングルス" : "ダブルス"}</strong>
                        <small>{option === "singles" ? "4人で個人戦" : "2対2のチーム戦"}</small>
                      </span>
                    </AppRadio.Content>
                  </AppRadio>
                ))}
              </div>
            </RadioGroup>
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
        <AppButton
          type="submit"
          className="w-full min-h-12"
          isDisabled={blocked}
          isPending={entryBusy}
        >
          {unavailable
            ? "準備中"
            : intent === "join"
              ? "参加する"
              : intent === "quick"
                ? "CPUとの待機室へ"
                : "ルームを作る"}
          {!unavailable && <AppIcon name="arrow" />}
        </AppButton>
      </form>
    </AppDialog>
  );
}
