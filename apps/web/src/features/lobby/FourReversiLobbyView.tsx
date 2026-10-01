import { Button, Card } from "@heroui/react";
import { type RoomMode, type RoomPublicMetadata } from "@tetraboard/protocol";
import { useState } from "react";
import { Link } from "react-router";
import { fourReversiLobbyPath } from "../../app/paths";
import { HowToPlayDialog } from "./HowToPlayDialog";
import { LobbyIcon } from "./LobbyIcon";
import { LobbyList } from "./LobbyList";
import { RoomEntryDialog } from "./RoomEntryDialog";
import { type RoomEntryIntent } from "./useRoomEntry";
import "./heroui.css";
import "./lobby.css";

type Props = {
  name: string;
  roomCode: string;
  mode: RoomMode;
  isSubmitting: RoomEntryIntent | null;
  message: string | null;
  lobbyRooms: RoomPublicMetadata[];
  lobbyNextCursor: string | null;
  lobbyError: string | null;
  lobbyLoading: boolean;
  lobbyMoreLoading: boolean;
  onNameChange: (value: string) => void;
  onRoomCodeChange: (value: string) => void;
  onModeChange: (mode: RoomMode) => void;
  onClearMessage: () => void;
  onSubmitRoom: (intent: RoomEntryIntent, roomId?: string) => void;
  onWatchRoom: (roomId: string) => void;
  onLobbyRefresh: () => void;
  onLobbyLoadMore: () => void;
};

type ActiveDialog =
  | { type: "entry"; intent: RoomEntryIntent; roomId?: string }
  | { type: "rules" }
  | null;

const previewStones: Record<number, string> = {
  19: "black",
  28: "black",
  35: "white",
  44: "white",
  27: "red",
  34: "red",
  29: "blue",
  36: "blue",
};

export function FourReversiLobbyView(props: Props) {
  const [dialog, setDialog] = useState<ActiveDialog>(null);

  function openEntry(intent: RoomEntryIntent, roomId?: string): void {
    props.onClearMessage();
    setDialog({ type: "entry", intent, roomId });
  }

  function closeDialog(): void {
    if (props.isSubmitting === null) setDialog(null);
  }

  return (
    <div className="four-reversi-lobby">
      <header className="lobby-header">
        <div className="lobby-header-inner">
          <Link
            className="lobby-brand"
            to={fourReversiLobbyPath}
            aria-label="TetraBoard 四人リバーシのロビー"
          >
            <span className="lobby-brand-icon">
              <img src="/favicon.ico" width="34" height="34" alt="" />
            </span>
            <span>
              Tetra<span className="lobby-brand-accent">Board</span>
            </span>
          </Link>
          <span className="lobby-header-caption">4人の遊びを、もっと気軽に。</span>
        </div>
      </header>
      <main className="lobby-main">
        <div className="lobby-title-row">
          <div>
            <h1>四人リバーシ</h1>
            <p className="lobby-title-description">ひとりでも、友達とでも。4色で楽しむリバーシ。</p>
          </div>
          <Button
            className="lobby-button lobby-button-quiet"
            variant="ghost"
            type="button"
            onPress={() => setDialog({ type: "rules" })}
          >
            <LobbyIcon name="help" />
            遊び方
          </Button>
        </div>

        <section aria-label="すぐ遊ぶ">
          <Card className="lobby-quick">
            <Card.Content className="lobby-quick-content">
              <Button
                className="lobby-button lobby-button-primary lobby-quick-button"
                type="button"
                onPress={() => openEntry("quick")}
              >
                すぐ遊ぶ
                <LobbyIcon name="arrow" />
              </Button>
              <p className="lobby-quick-caption">CPU3人と対戦</p>
            </Card.Content>
            <div className="lobby-board-scene" aria-hidden="true">
              <div className="lobby-preview-board">
                {Array.from({ length: 64 }, (_, index) => (
                  <span className="lobby-preview-cell" key={index}>
                    {previewStones[index] && (
                      <span className={`lobby-preview-stone lobby-stone-${previewStones[index]}`} />
                    )}
                  </span>
                ))}
              </div>
              <span className="lobby-board-caption">黒 → 白 → 赤 → 青</span>
            </div>
          </Card>
        </section>

        <section className="lobby-friends" aria-labelledby="friends-title">
          <div className="lobby-section-heading">
            <div>
              <h2 id="friends-title">友達と遊ぶ</h2>
              <p>ルームを作って招待するか、番号で合流しましょう。</p>
            </div>
          </div>
          <div className="lobby-friend-actions">
            <Card className="lobby-friend-card">
              <Button
                className="lobby-friend-action"
                variant="secondary"
                type="button"
                onPress={() => openEntry("create")}
              >
                <span className="lobby-action-icon">
                  <LobbyIcon name="plus" />
                </span>
                <span className="lobby-action-copy">
                  <strong>ルームを作る</strong>
                  <span>友達を招待して、一緒に対戦</span>
                </span>
                <LobbyIcon name="arrow" />
              </Button>
            </Card>
            <Card className="lobby-friend-card">
              <Button
                className="lobby-friend-action"
                variant="secondary"
                type="button"
                onPress={() => openEntry("join")}
              >
                <span className="lobby-action-icon">
                  <LobbyIcon name="join" />
                </span>
                <span className="lobby-action-copy">
                  <strong>ルーム番号で参加</strong>
                  <span>5桁の番号を入力して合流</span>
                </span>
                <LobbyIcon name="arrow" />
              </Button>
            </Card>
          </div>
        </section>

        <LobbyList
          rooms={props.lobbyRooms}
          nextCursor={props.lobbyNextCursor}
          error={props.lobbyError}
          loading={props.lobbyLoading}
          moreLoading={props.lobbyMoreLoading}
          onRefresh={props.onLobbyRefresh}
          onLoadMore={props.onLobbyLoadMore}
          onJoin={(roomId) => openEntry("join", roomId)}
          onWatch={props.onWatchRoom}
        />
        <footer className="lobby-footer">TetraBoard</footer>
      </main>
      {dialog?.type === "entry" && (
        <RoomEntryDialog
          intent={dialog.intent}
          selectedRoomId={dialog.roomId}
          name={props.name}
          roomCode={props.roomCode}
          mode={props.mode}
          busy={props.isSubmitting !== null}
          message={props.message}
          onNameChange={props.onNameChange}
          onRoomCodeChange={props.onRoomCodeChange}
          onModeChange={props.onModeChange}
          onSubmit={() => props.onSubmitRoom(dialog.intent, dialog.roomId)}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === "rules" && <HowToPlayDialog onClose={closeDialog} />}
    </div>
  );
}
