import {
  roomTimeControl,
  type RoomError,
  type RoomMode,
  type RoomPublicMetadata,
} from "@tetraboard/protocol";
import { type FormEvent } from "react";
import { LobbyList } from "./LobbyList";
import { type ApiStatus } from "./useApiStatus";
import { type RoomEntryIntent } from "./useRoomEntry";

type Props = {
  apiStatus: ApiStatus;
  name: string;
  roomCode: string;
  mode: RoomMode;
  isSubmitting: RoomEntryIntent | null;
  roomResponse: RoomError | null;
  responseStatus: number | null;
  message: string | null;
  lobbyRooms: RoomPublicMetadata[];
  lobbyNextCursor: string | null;
  lobbyError: string | null;
  lobbyLoading: boolean;
  lobbyMoreLoading: boolean;
  onNameChange: (value: string) => void;
  onRoomCodeChange: (value: string) => void;
  onModeChange: (mode: RoomMode) => void;
  onSubmitRoom: (intent: RoomEntryIntent, roomId?: string) => void;
  onWatchRoom: (roomId: string) => void;
  onLobbyRefresh: () => void;
  onLobbyLoadMore: () => void;
};

export function HomeView({
  apiStatus,
  name,
  roomCode,
  mode,
  isSubmitting,
  roomResponse,
  responseStatus,
  message,
  lobbyRooms,
  lobbyNextCursor,
  lobbyError,
  lobbyLoading,
  lobbyMoreLoading,
  onNameChange,
  onRoomCodeChange,
  onModeChange,
  onSubmitRoom,
  onWatchRoom,
  onLobbyRefresh,
  onLobbyLoadMore,
}: Props) {
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const intent =
      submitter instanceof HTMLButtonElement && submitter.value === "join"
        ? "join"
        : submitter instanceof HTMLButtonElement && submitter.value === "quick"
          ? "quick"
          : "create";
    onSubmitRoom(intent);
  }

  return (
    <>
      <p>APIステータス：{apiStatus}</p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="nickname">ニックネーム</label>
        <input id="nickname" value={name} onChange={(event) => onNameChange(event.target.value)} />
        <label htmlFor="room-mode">作成するルームの対局モード</label>
        <select
          id="room-mode"
          value={mode}
          onChange={(event) => onModeChange(event.target.value as RoomMode)}
          disabled={isSubmitting !== null}
        >
          <option value="singles">シングルス</option>
          <option value="doubles">ダブルス</option>
        </select>
        <p>
          持ち時間：{roomTimeControl.mainTimeMs / 60_000}分＋1手
          {roomTimeControl.byoyomiMs / 1000}秒
        </p>
        <button
          type="submit"
          value="create"
          disabled={isSubmitting !== null}
          onClick={(event) => {
            event.preventDefault();
            onSubmitRoom("create");
          }}
        >
          {isSubmitting === "create" ? "作成中" : "ルーム作成"}
        </button>
        <button
          type="submit"
          value="quick"
          disabled={isSubmitting !== null}
          onClick={(event) => {
            event.preventDefault();
            onSubmitRoom("quick");
          }}
        >
          {isSubmitting === "quick" ? "作成中" : "すぐ遊ぶ"}
        </button>
        <label htmlFor="room-code">部屋番号</label>
        <input
          id="room-code"
          inputMode="numeric"
          value={roomCode}
          onChange={(event) => onRoomCodeChange(event.target.value)}
        />
        <button
          type="submit"
          value="join"
          disabled={isSubmitting !== null}
          onClick={(event) => {
            event.preventDefault();
            onSubmitRoom("join");
          }}
        >
          {isSubmitting === "join" ? "入室中" : "入室"}
        </button>
      </form>
      {message && <p role="status">{message}</p>}
      {roomResponse && (
        <section aria-label="APIの応答">
          <p>HTTP {responseStatus}</p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(roomResponse, null, 2)}
          </pre>
        </section>
      )}
      <LobbyList
        rooms={lobbyRooms}
        nextCursor={lobbyNextCursor}
        error={lobbyError}
        loading={lobbyLoading}
        moreLoading={lobbyMoreLoading}
        isSubmitting={isSubmitting !== null}
        onRefresh={onLobbyRefresh}
        onLoadMore={onLobbyLoadMore}
        onJoin={(roomId) => onSubmitRoom("join", roomId)}
        onWatch={onWatchRoom}
      />
    </>
  );
}
