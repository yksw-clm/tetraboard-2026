import {
  createRoomContract,
  getRoomContract,
  healthzContract,
  joinRoomContract,
  listRoomsContract,
  roomCodeSchema,
  roomTimeControl,
  type RoomError,
  type RoomMode,
  type RoomPublicMetadata,
} from "@tetraboard/protocol";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import {
  canStoreRoomMembership,
  fetchRoomMembership,
  saveRoomMembershipToken,
} from "./roomMembership";

type ApiStatus = "確認中" | "OK" | "接続失敗";

export function App() {
  const navigate = useNavigate();
  const [apiStatus, setApiStatus] = useState<ApiStatus>("確認中");
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [mode, setMode] = useState<RoomMode>("singles");
  const [isSubmitting, setIsSubmitting] = useState<"create" | "quick" | "join" | null>(null);
  const [roomResponse, setRoomResponse] = useState<RoomError | null>(null);
  const [responseStatus, setResponseStatus] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lobbyRooms, setLobbyRooms] = useState<RoomPublicMetadata[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);
  const [lobbyLoading, setLobbyLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreLoaded, setMoreLoaded] = useState(false);
  const lobbyRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function checkHealth(): Promise<void> {
      try {
        const response = await fetch(`/api${healthzContract.path}`, {
          cache: "no-store",
          method: healthzContract.method,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error("Health check failed");
        }

        const body: unknown = await response.json();
        healthzContract.response.parse(body);

        if (!controller.signal.aborted) {
          setApiStatus("OK");
        }
      } catch {
        if (!controller.signal.aborted) {
          setApiStatus("接続失敗");
        }
      }
    }

    void checkHealth();
    return () => controller.abort();
  }, []);

  async function fetchLobby(cursor: string | null, signal: AbortSignal) {
    const path = cursor
      ? `${listRoomsContract.path}?cursor=${encodeURIComponent(cursor)}`
      : listRoomsContract.path;
    const response = await fetch(`/api${path}`, {
      method: listRoomsContract.method,
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error("Lobby request failed");
    return listRoomsContract.response.parse(await response.json());
  }

  async function refreshLobby(): Promise<void> {
    lobbyRequest.current?.abort();
    const controller = new AbortController();
    lobbyRequest.current = controller;
    setMoreLoading(false);
    setLobbyLoading(true);
    try {
      const page = await fetchLobby(null, controller.signal);
      if (controller.signal.aborted) return;
      setLobbyRooms(page.rooms);
      setNextCursor(page.nextCursor);
      setMoreLoaded(false);
      setLobbyError(null);
    } catch {
      if (!controller.signal.aborted) setLobbyError("ロビーの一覧を取得できませんでした。");
    } finally {
      if (lobbyRequest.current === controller) setLobbyLoading(false);
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => void refreshLobby(), 0);
    return () => {
      window.clearTimeout(timeout);
      lobbyRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !moreLoaded) void refreshLobby();
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [moreLoaded]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null || moreLoading) return;
    setMoreLoading(true);
    const controller = new AbortController();
    lobbyRequest.current?.abort();
    lobbyRequest.current = controller;
    setLobbyLoading(false);
    try {
      const page = await fetchLobby(nextCursor, controller.signal);
      if (controller.signal.aborted) return;
      setLobbyRooms((current) => [
        ...current,
        ...page.rooms.filter((room) => !current.some((entry) => entry.id === room.id)),
      ]);
      setNextCursor(page.nextCursor);
      setMoreLoaded(true);
      setLobbyError(null);
    } catch {
      if (!controller.signal.aborted) setLobbyError("続きのルームを取得できませんでした。");
    } finally {
      if (lobbyRequest.current === controller) setMoreLoading(false);
    }
  }

  async function submitRoom(
    intent: "create" | "quick" | "join",
    selectedRoomCode = roomCode,
  ): Promise<void> {
    if (isSubmitting !== null) return;
    const contract = intent === "join" ? joinRoomContract : createRoomContract;

    setRoomResponse(null);
    setResponseStatus(null);
    setMessage(null);

    if (intent === "join" && !roomCodeSchema.safeParse(selectedRoomCode).success) {
      setMessage("部屋番号は5桁の数字で入力してください。");
      return;
    }

    if (!canStoreRoomMembership()) {
      setMessage("このタブでは参加情報を保存できません。ブラウザの設定を確認してください。");
      return;
    }

    setIsSubmitting(intent);

    try {
      if (intent === "join") {
        const existingMembership = await fetchRoomMembership(selectedRoomCode);
        if (existingMembership !== null) {
          void navigate(getRoomContract.pathFor(selectedRoomCode));
          return;
        }
      }

      const request = contract.request.safeParse(
        intent === "join" ? { name } : { name, quickPlay: intent === "quick", mode },
      );
      if (!request.success) {
        setMessage("ニックネームを1〜10文字で入力してください。");
        return;
      }

      const path =
        intent === "join" ? joinRoomContract.pathFor(selectedRoomCode) : createRoomContract.path;
      const response = await fetch(`/api${path}`, {
        method: contract.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.data),
      });
      const body: unknown = await response.json();

      if (response.status === (intent === "join" ? 200 : 201)) {
        const result = contract.response.parse(body);
        if (intent === "join" && result.room.id !== selectedRoomCode) {
          throw new Error("Room code does not match response");
        }
        if (
          result.membership.role !== (intent === "join" ? "player" : "host") ||
          !result.room.players.some((player) => player.id === result.membership.playerId)
        ) {
          throw new Error("Membership does not match room");
        }
        if (!saveRoomMembershipToken(result.room.id, result.membership.token)) {
          throw new Error("Failed to store membership");
        }
        void navigate(getRoomContract.pathFor(result.room.id));
      } else {
        const error = contract.error.parse(body);
        setRoomResponse(error);
        setResponseStatus(response.status);
        if (intent === "join") {
          setMessage(
            error.error === "not_found"
              ? "ルームが見つかりません。"
              : error.error === "room_full"
                ? "このルームは満室です。"
                : error.error === "room_started"
                  ? "このルームの対局は始まっています。"
                  : "入室できませんでした。",
          );
        }
      }
    } catch (error) {
      setMessage(
        error instanceof Response && error.status === 404
          ? "ルームが見つかりません。"
          : intent === "join"
            ? "入室または本人確認の応答を確認できませんでした。"
            : "ルーム作成の応答を確認できませんでした。",
      );
    } finally {
      setIsSubmitting(null);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const intent =
      submitter instanceof HTMLButtonElement && submitter.value === "join"
        ? "join"
        : submitter instanceof HTMLButtonElement && submitter.value === "quick"
          ? "quick"
          : "create";
    void submitRoom(intent);
  }

  return (
    <>
      <p>APIステータス：{apiStatus}</p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="nickname">ニックネーム</label>
        <input id="nickname" value={name} onChange={(event) => setName(event.target.value)} />
        <label htmlFor="room-mode">作成するルームの対局モード</label>
        <select
          id="room-mode"
          value={mode}
          onChange={(event) => setMode(event.target.value as RoomMode)}
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
            void submitRoom("create");
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
            void submitRoom("quick");
          }}
        >
          {isSubmitting === "quick" ? "作成中" : "すぐ遊ぶ"}
        </button>
        <label htmlFor="room-code">部屋番号</label>
        <input
          id="room-code"
          inputMode="numeric"
          value={roomCode}
          onChange={(event) => setRoomCode(event.target.value)}
        />
        <button
          type="submit"
          value="join"
          disabled={isSubmitting !== null}
          onClick={(event) => {
            event.preventDefault();
            void submitRoom("join");
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
      <section aria-label="公開ロビー">
        <h2>公開ロビー</h2>
        <button type="button" onClick={() => void refreshLobby()} disabled={lobbyLoading}>
          更新
        </button>
        {lobbyError && <p role="status">{lobbyError}</p>}
        {lobbyRooms.length === 0 && !lobbyLoading && !lobbyError && <p>ルームはありません。</p>}
        <ul>
          {lobbyRooms.map((room) => (
            <li key={room.id}>
              <span>
                {room.id} / 四人リバーシ / {room.mode === "singles" ? "シングルス" : "ダブルス"} /{" "}
                {room.status} / 持ち時間{room.timeControl.mainTimeMs / 60_000}分＋1手
                {room.timeControl.byoyomiMs / 1000}秒 / ホスト：{room.hostName ?? "なし"} / 人間
                {room.humanCount}人・CPU{room.cpuCount}体 / 空席{room.openSeats}/{room.capacity}
              </span>{" "}
              {room.status === "waiting" && room.openSeats > 0 && (
                <button
                  type="button"
                  disabled={isSubmitting !== null}
                  onClick={() => void submitRoom("join", room.id)}
                >
                  入室
                </button>
              )}{" "}
              <button type="button" onClick={() => void navigate(getRoomContract.pathFor(room.id))}>
                観戦
              </button>
            </li>
          ))}
        </ul>
        {nextCursor !== null && (
          <button type="button" onClick={() => void loadMore()} disabled={moreLoading}>
            もっと見る
          </button>
        )}
      </section>
    </>
  );
}
