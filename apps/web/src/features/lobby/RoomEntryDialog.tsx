import { RoomIdentityFields } from "../account/RoomIdentityFields";
import { useAccount } from "../account/useAccount";
import { Label, Radio, RadioGroup } from "@heroui/react";
import { AppButton } from "../../shared/ui/AppButton";
import { AppTextField } from "../../shared/ui/AppTextField";
import { roomTimeControl, type RoomMode } from "@tetraboard/protocol";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppIcon } from "../../shared/ui/AppIcon";
import { type RoomEntryIntent } from "./useRoomEntry";

export function RoomEntryDialog({
  intent,
  selectedRoomId,
  name,
  roomCode,
  mode,
  busy,
  message,
  onNameChange,
  onRoomCodeChange,
  onModeChange,
  onSubmit,
  onClose,
}: {
  intent: RoomEntryIntent;
  selectedRoomId?: string;
  name: string;
  roomCode: string;
  mode: RoomMode;
  busy: boolean;
  message: string | null;
  onNameChange: (value: string) => void;
  onRoomCodeChange: (value: string) => void;
  onModeChange: (mode: RoomMode) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const account = useAccount();
  const blocked = busy || account.loading || Boolean(account.error);
  const title =
    intent === "quick"
      ? "すぐ遊ぶ"
      : intent === "create"
        ? "ルームを作る"
        : selectedRoomId
          ? `ルーム ${selectedRoomId} に参加`
          : "ルーム番号で参加";

  return (
    <AppDialog title={title} busy={busy} onClose={onClose}>
      <p className="text-muted text-[13px] leading-[1.8]">
        {intent === "quick"
          ? "CPU3人と対戦。待機室で「対局開始」を押すと始まります。"
          : intent === "create"
            ? "ルームを作って、URLやルーム番号で友達を招待しましょう。"
            : account.user
              ? "アカウントのプロフィールで参加します。"
              : "対局で使うニックネームを入力してください。"}
      </p>
      <form
        className="flex flex-col gap-[22px] mt-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <RoomIdentityFields name={name} onChange={onNameChange} busy={busy} id="nickname" />
        {intent === "join" ? (
          selectedRoomId ? (
            <p className="py-[13px] px-4 rounded-control text-muted bg-[#f0f6f2] text-[13px] [&_strong]:ml-3 [&_strong]:text-ink [&_strong]:text-[17px] [&_strong]:tabular-nums [&_strong]:tracking-[0.08em]">
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
                  <Radio key={option} value={option}>
                    <Radio.Content className="flex items-center gap-[9px] py-[13px] px-3 border border-solid border-line rounded-[11px] cursor-pointer font-normal w-full data-[selected=true]:border-[#60a981] data-[selected=true]:bg-[#f0f8f3] [&_strong]:block [&_strong]:text-[13px] [&_small]:block [&_small]:mt-[3px] [&_small]:text-muted [&_small]:text-[11px]">
                      <Radio.Control className="shrink-0 border border-solid border-input">
                        <Radio.Indicator />
                      </Radio.Control>
                      <span>
                        <strong>{option === "singles" ? "シングルス" : "ダブルス"}</strong>
                        <small>{option === "singles" ? "4人で個人戦" : "2対2のチーム戦"}</small>
                      </span>
                    </Radio.Content>
                  </Radio>
                ))}
              </div>
            </RadioGroup>
            <p className="text-xs text-muted">
              持ち時間：1人{roomTimeControl.mainTimeMs / 60_000}分＋1手
              {roomTimeControl.byoyomiMs / 1000}秒の秒読み
            </p>
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
        <AppButton type="submit" className="w-full min-h-12" isDisabled={blocked}>
          {busy
            ? intent === "join"
              ? "参加中…"
              : "ルームを作成中…"
            : intent === "join"
              ? "参加する"
              : intent === "quick"
                ? "CPUとの待機室へ"
                : "ルームを作る"}
          {!busy && <AppIcon name="arrow" />}
        </AppButton>
        {busy && (
          <p className="text-xs text-muted" role="status">
            ルームを開いています。そのままお待ちください。
          </p>
        )}
      </form>
    </AppDialog>
  );
}
