import { Accordion, Button, Card, Chip, Label, Radio, RadioGroup } from "@heroui/react";
import { Link } from "react-router";
import { fourReversiLobbyPath } from "../../app/paths";
import { RoomIcon } from "./RoomIcon";
import { formatClock, playerName } from "./roomPresentation";
import { type useRoomSession } from "./useRoomSession";

export function RoomInfo({
  session,
  onLeave,
}: {
  session: ReturnType<typeof useRoomSession>;
  onLeave: () => void;
}) {
  const { room, membership, canManageSettings } = session;
  return (
    <Card className="room-info">
      <div className="room-card-heading">
        <h1>ルーム情報</h1>
        <Chip className="room-number" size="sm">
          #{room.id}
        </Chip>
      </div>
      <dl className="room-facts">
        <div>
          <RoomIcon name="board" />
          <div>
            <dt>ゲーム名</dt>
            <dd>四人リバーシ</dd>
          </div>
        </div>
        <div>
          <RoomIcon name="user" />
          <div>
            <dt>対局形式</dt>
            <dd>{room.settings.mode === "singles" ? "シングルス" : "ダブルス"}</dd>
          </div>
        </div>
        <div>
          <RoomIcon name="clock" />
          <div>
            <dt>持ち時間</dt>
            <dd>{formatClock(room.settings.timeControl.mainTimeMs)}</dd>
          </div>
        </div>
        <div>
          <RoomIcon name="clock" />
          <div>
            <dt>秒読み</dt>
            <dd>{formatClock(room.settings.timeControl.byoyomiMs)}</dd>
          </div>
        </div>
      </dl>
      {membership === null && <p className="room-muted">観戦中です</p>}
      {room.status === "waiting" && membership?.role === "host" && (
        <Accordion className="room-settings">
          <Accordion.Item>
            <Accordion.Heading>
              <Accordion.Trigger>
                <RoomIcon name="settings" />
                ルーム設定
                <Accordion.Indicator />
              </Accordion.Trigger>
            </Accordion.Heading>
            <Accordion.Panel>
              <Accordion.Body>
                <RadioGroup
                  value={room.settings.mode}
                  isDisabled={!canManageSettings}
                  onChange={(value) => {
                    if (value === "singles" || value === "doubles") session.changeMode(value);
                  }}
                  orientation="horizontal"
                  className="room-mode"
                >
                  <Label>対局形式</Label>
                  <div className="room-radio-options">
                    {(["singles", "doubles"] as const).map((mode) => (
                      <Radio key={mode} value={mode}>
                        <Radio.Control>
                          <Radio.Indicator />
                        </Radio.Control>
                        <Radio.Content>
                          {mode === "singles" ? "シングルス" : "ダブルス"}
                        </Radio.Content>
                      </Radio>
                    ))}
                  </div>
                </RadioGroup>
                <div className="room-cpu-settings">
                  <p className="room-settings-label">CPUの設定</p>
                  {room.players
                    .filter((player) => player.kind === "cpu")
                    .map((cpu, index) => (
                      <div key={cpu.id} className="room-cpu-row">
                        <span>
                          <RoomIcon name="robot" />
                          CPU {index + 1}
                        </span>
                        <div
                          className="room-level-buttons"
                          role="group"
                          aria-label={`CPU ${index + 1}のレベル`}
                        >
                          {([1, 2] as const).map((level) => (
                            <Button
                              key={level}
                              size="sm"
                              className={`room-level ${cpu.level === level ? "is-selected" : ""}`}
                              aria-pressed={cpu.level === level}
                              isDisabled={!canManageSettings}
                              onPress={() => session.changeCpuLevel(cpu.id, level)}
                            >
                              Lv{level}
                            </Button>
                          ))}
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="room-remove"
                          aria-label={`${playerName(cpu)}を削除`}
                          isDisabled={!canManageSettings}
                          onPress={() => session.removeCpu(cpu.id)}
                        >
                          削除
                        </Button>
                      </div>
                    ))}
                  <div className="room-cpu-add">
                    <div
                      className="room-level-buttons"
                      role="group"
                      aria-label="追加するCPUのレベル"
                    >
                      {([1, 2] as const).map((level) => (
                        <Button
                          key={level}
                          size="sm"
                          className={`room-level ${session.newCpuLevel === level ? "is-selected" : ""}`}
                          aria-pressed={session.newCpuLevel === level}
                          isDisabled={!canManageSettings}
                          onPress={() => session.setNewCpuLevel(level)}
                        >
                          Lv{level}
                        </Button>
                      ))}
                    </div>
                    <Button
                      className="room-button room-button-secondary"
                      size="sm"
                      isDisabled={!canManageSettings || room.players.length >= 4}
                      onPress={() => session.addCpu(session.newCpuLevel)}
                    >
                      <RoomIcon name="plus" />
                      CPUを追加
                    </Button>
                  </div>
                </div>
              </Accordion.Body>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
      {membership ? (
        <Button
          className="room-button room-button-danger room-leave"
          isDisabled={session.leaving}
          onPress={onLeave}
        >
          <RoomIcon name="leave" />
          {session.leaving ? "退室中…" : "退室"}
        </Button>
      ) : (
        <Link className="room-button room-button-secondary room-leave" to={fourReversiLobbyPath}>
          ロビーへ戻る
        </Link>
      )}
    </Card>
  );
}
