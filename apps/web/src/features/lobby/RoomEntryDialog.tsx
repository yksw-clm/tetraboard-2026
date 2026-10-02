import { Label, Radio, RadioGroup } from "@heroui/react";
import { AppButton } from "../../shared/ui/AppButton";
import { AppTextField } from "../../shared/ui/AppTextField";
import { roomTimeControl, type RoomMode } from "@tetraboard/protocol";
import { LobbyDialog } from "./LobbyDialog";
import { LobbyIcon } from "./LobbyIcon";
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
  const title =
    intent === "quick"
      ? "すぐ遊ぶ"
      : intent === "create"
        ? "ルームを作る"
        : selectedRoomId
          ? `ルーム ${selectedRoomId} に参加`
          : "ルーム番号で参加";

  return (
    <LobbyDialog title={title} busy={busy} onClose={onClose}>
      <p className="lobby-dialog-intro">
        {intent === "quick"
          ? "CPU3人と対戦。待機室で「対局開始」を押すと始まります。"
          : intent === "create"
            ? "ルームを作って、URLやルーム番号で友達を招待しましょう。"
            : "対局で使うニックネームを入力してください。"}
      </p>
      <form
        className="lobby-entry-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <AppTextField value={name} onChange={onNameChange} isDisabled={busy}>
          <AppTextField.Label>ニックネーム</AppTextField.Label>
          <AppTextField.Input
            id="nickname"
            autoFocus
            autoComplete="nickname"
            placeholder="例：てとら"
          />
          <AppTextField.Description>
            1〜10文字。ユーザー登録は必要ありません。
          </AppTextField.Description>
        </AppTextField>
        {intent === "join" ? (
          selectedRoomId ? (
            <p className="lobby-room-number">
              参加するルーム <strong>{selectedRoomId}</strong>
            </p>
          ) : (
            <AppTextField value={roomCode} onChange={onRoomCodeChange} isDisabled={busy}>
              <AppTextField.Label>ルーム番号</AppTextField.Label>
              <AppTextField.Input
                id="room-code"
                className="lobby-code-input"
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
              className="lobby-mode-field"
              name="mode"
              value={mode}
              onChange={(value) => {
                if (value === "singles" || value === "doubles") onModeChange(value);
              }}
              isDisabled={busy}
              orientation="horizontal"
            >
              <Label>対局モード</Label>
              <div className="lobby-mode-options">
                {(["singles", "doubles"] as const).map((option) => (
                  <Radio key={option} value={option}>
                    <Radio.Content className="lobby-mode-option">
                      <Radio.Control>
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
          <p className="lobby-error" role="alert">
            {message}
          </p>
        )}
        <AppButton type="submit" className="w-full min-h-12" isDisabled={busy}>
          {busy
            ? intent === "join"
              ? "参加中…"
              : "ルームを作成中…"
            : intent === "join"
              ? "参加する"
              : intent === "quick"
                ? "CPUとの待機室へ"
                : "ルームを作る"}
          {!busy && <LobbyIcon name="arrow" />}
        </AppButton>
        {busy && (
          <p className="text-xs text-muted" role="status">
            ルームを開いています。そのままお待ちください。
          </p>
        )}
      </form>
    </LobbyDialog>
  );
}
