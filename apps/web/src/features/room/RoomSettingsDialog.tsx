import { useEffect, useState } from "react";
import { gameCatalog } from "@tetraboard/protocol/games";
import type { Room, RoomSettingsApplyCommand, CpuLevel } from "@tetraboard/protocol";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppButton } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import { gameThemes } from "../../shared/ui/appTheme";
import { RoomModeSetting } from "../lobby/RoomModeSetting";
import { ThreePlayerAttackSetting } from "../lobby/ThreePlayerAttackSetting";
import { GomokuForbiddenControl } from "../lobby/GomokuForbiddenControl";
import { useAccount } from "../account/useAccount";
import { CpuMatchNotice } from "../account/CpuMatchNotice";
import { TimeControlSetting } from "./TimeControlSetting";
import { CpuLevelSelector } from "./CpuLevelSelector";
import type { SharedRoomSession } from "./useRoomTransport";
import { commonSettingsComplete } from "./roomSettingsCompletion";
import { updatingSettingsClasses } from "./roomSettingsPresentation";
import { useCpuAddition } from "./useCpuAddition";

function settingsDraft(room: Room) {
  const command: RoomSettingsApplyCommand = {
    type: "room.settings.apply",
    expectedPublicUpdatedAtMs: room.publicUpdatedAtMs,
    timeControl: room.settings.timeControl,
    ...(gameCatalog[room.settings.game].hasModes ? { mode: room.settings.mode } : {}),
    ...(room.settings.game === "four-shogi"
      ? { threePlayerAttackProhibited: room.settings.threePlayerAttackProhibited }
      : {}),
    ...(room.settings.game === "gomoku" ? { forbiddenRules: room.settings.forbiddenRules } : {}),
    cpus: room.players.flatMap((player) =>
      player.kind === "cpu" ? [{ playerId: player.id, level: player.level }] : [],
    ),
  };
  return {
    ...command,
    cpus: command.cpus.map((cpu) => ({ ...cpu, key: cpu.playerId! })),
    playerIds: room.players.map((player) => player.id),
  };
}
type Draft = ReturnType<typeof settingsDraft>;
function draftCommand({ cpus, playerIds: _ids, ...command }: Draft): RoomSettingsApplyCommand {
  return { ...command, cpus: cpus.map(({ key: _key, ...cpu }) => cpu) };
}

export function RoomSettingsDialog({
  session,
  onClose,
}: {
  session: SharedRoomSession;
  onClose: () => void;
}) {
  const { room } = session;
  const account = useAccount();
  const [initial, setInitial] = useState(() => settingsDraft(room));
  const [draft, setDraft] = useState(initial);
  const [level, setLevel] = useState<CpuLevel>(session.newCpuLevel);
  const [submitted, setSubmitted] = useState(false);
  const busy = session.pendingSettingsCommand !== null;
  const blocked = !session.canManageSettings || session.leaving;
  const stale = room.publicUpdatedAtMs !== draft.expectedPublicUpdatedAtMs;
  const command = draftCommand(draft);
  const changed = JSON.stringify(command) !== JSON.stringify(draftCommand(initial));
  const added = draft.cpus.filter((cpu) => cpu.playerId === null);
  const accountUnavailable = added.length > 0 && (account.loading || Boolean(account.error));
  const submit = () => {
    if (blocked || stale || accountUnavailable) return;
    setSubmitted(true);
    session.applySettings(command);
  };
  const addition = useCpuAddition({
    room,
    membership: session.membership,
    hostPlayerId: session.presence.hostPlayerId,
    canManageSettings: session.canManageSettings && !stale,
    account,
    addCpu: submit,
  });
  const confirming = addition.confirmation !== null;
  useEffect(() => {
    if (room.status !== "waiting" || session.membership?.role !== "host") onClose();
    else if (
      submitted &&
      !busy &&
      !session.socketError &&
      commonSettingsComplete(room, command, new Set(initial.playerIds))
    )
      onClose();
  }, [
    room,
    session.membership?.role,
    submitted,
    busy,
    session.socketError,
    command,
    initial.playerIds,
    onClose,
  ]);
  function reload() {
    const fresh = settingsDraft(room);
    setInitial(fresh);
    setDraft(fresh);
    setSubmitted(false);
    addition.cancel();
  }
  const humans = room.players.filter((player) => player.kind === "human").length;
  return (
    <AppDialog
      title="ルーム設定"
      onClose={onClose}
      busy={busy}
      theme={gameThemes[room.settings.game]}
    >
      <p className="text-sm text-muted">
        設定を編集して「適用」を押すと、変更をまとめて反映します。
      </p>
      <form
        className={`mt-5 flex min-w-0 flex-col gap-5 ${busy ? updatingSettingsClasses : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (blocked || stale || !changed || accountUnavailable) return;
          if (confirming) addition.confirm();
          else if (
            added.length > 0 &&
            account.user &&
            !room.players.some((player) => player.kind === "cpu")
          )
            addition.request(added[0]!.level);
          else submit();
        }}
      >
        <fieldset
          disabled={blocked || confirming}
          className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0"
        >
          {draft.mode !== undefined && (
            <RoomModeSetting
              mode={draft.mode}
              disabled={blocked || confirming}
              onChange={(mode) => setDraft((current) => ({ ...current, mode }))}
            />
          )}
          {draft.threePlayerAttackProhibited !== undefined && (
            <ThreePlayerAttackSetting
              prohibited={draft.threePlayerAttackProhibited}
              disabled={blocked || confirming}
              onChange={(threePlayerAttackProhibited) =>
                setDraft((current) => ({ ...current, threePlayerAttackProhibited }))
              }
            />
          )}
          {draft.forbiddenRules !== undefined && (
            <GomokuForbiddenControl
              enabled={draft.forbiddenRules}
              disabled={blocked || confirming}
              onChange={(forbiddenRules) => setDraft((current) => ({ ...current, forbiddenRules }))}
            />
          )}
          <TimeControlSetting
            timeControl={draft.timeControl}
            disabled={blocked || confirming}
            theme={gameThemes[room.settings.game]}
            onChange={(timeControl) => setDraft((current) => ({ ...current, timeControl }))}
          />
          <section aria-label="CPUの設定" className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">CPUの設定</h3>
            {draft.cpus.length === 0 && (
              <p className="text-xs text-muted">CPUは参加していません。</p>
            )}
            {draft.cpus.map((cpu, index) => (
              <div key={cpu.key} className="flex flex-wrap items-center gap-2">
                <span className="mr-auto inline-flex items-center gap-1.5 text-sm">
                  <AppIcon name="robot" />
                  CPU {index + 1}
                </span>
                <CpuLevelSelector
                  label={`CPU ${index + 1}のレベル`}
                  level={cpu.level}
                  disabled={blocked || confirming}
                  updating={busy}
                  onChange={(level) =>
                    setDraft((current) => ({
                      ...current,
                      cpus: current.cpus.map((entry) =>
                        entry.key === cpu.key ? { ...entry, level } : entry,
                      ),
                    }))
                  }
                />
                <AppButton
                  appearance="quiet"
                  size="compact"
                  className="text-danger text-xs"
                  aria-label={`CPU ${index + 1}を削除`}
                  isDisabled={blocked || confirming}
                  onPress={() =>
                    setDraft((current) => ({
                      ...current,
                      cpus: current.cpus.filter((entry) => entry.key !== cpu.key),
                    }))
                  }
                >
                  削除
                </AppButton>
              </div>
            ))}
            <div className="flex justify-end items-center gap-2">
              <CpuLevelSelector
                label="追加するCPUのレベル"
                level={level}
                disabled={blocked || confirming}
                updating={busy}
                onChange={setLevel}
              />
              <AppButton
                appearance="secondary"
                size="compact"
                isDisabled={
                  blocked ||
                  confirming ||
                  account.loading ||
                  Boolean(account.error) ||
                  humans + draft.cpus.length >= gameCatalog[room.settings.game].capacity
                }
                onPress={() =>
                  setDraft((current) => ({
                    ...current,
                    cpus: [...current.cpus, { key: crypto.randomUUID(), playerId: null, level }],
                  }))
                }
              >
                <AppIcon name="plus" />
                CPUを追加
              </AppButton>
            </div>
          </section>
        </fieldset>
        {account.loading && (
          <p role="status" className="text-xs text-muted">
            ログイン状態を確認しています…
          </p>
        )}
        {account.error && (
          <div>
            <p role="alert" className="text-sm text-danger">
              {account.error}
            </p>
            <AppButton
              appearance="secondary"
              size="compact"
              isDisabled={account.loading}
              isPending={account.pendingSource === "room-retry"}
              onPress={() => void account.refresh("room-retry")}
            >
              ログイン状態を再確認
            </AppButton>
          </div>
        )}
        {stale && !busy && (
          <div>
            <p role="alert" className="text-sm text-danger">
              ルーム情報が更新されました。設定を読み直してください。
            </p>
            <AppButton appearance="secondary" size="compact" isDisabled={blocked} onPress={reload}>
              設定を読み直す
            </AppButton>
          </div>
        )}
        {submitted && session.socketError && (
          <p role="alert" className="text-sm text-danger">
            {session.socketError}
          </p>
        )}
        {confirming && (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold">CPUを追加しますか？</p>
            <CpuMatchNotice />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <AppButton
            appearance="secondary"
            isDisabled={busy}
            onPress={confirming ? addition.cancel : onClose}
          >
            {confirming ? "編集に戻る" : "キャンセル"}
          </AppButton>
          <AppButton
            type="submit"
            isPending={busy}
            isDisabled={blocked || stale || !changed || accountUnavailable}
          >
            {confirming ? "CPUを追加して適用" : "適用"}
          </AppButton>
        </div>
      </form>
    </AppDialog>
  );
}
