import {
  createRoomContract,
  getRoomContract,
  healthzContract,
  joinRoomContract,
  roomCodeSchema,
  type RoomError,
} from "@tetraboard/protocol";
import { useEffect, useState, type FormEvent } from "react";
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
  const [isSubmitting, setIsSubmitting] = useState<"create" | "join" | null>(null);
  const [roomResponse, setRoomResponse] = useState<RoomError | null>(null);
  const [responseStatus, setResponseStatus] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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

  async function submitRoom(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSubmitting !== null) return;

    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const intent =
      submitter instanceof HTMLButtonElement && submitter.value === "join" ? "join" : "create";
    const contract = intent === "join" ? joinRoomContract : createRoomContract;

    setRoomResponse(null);
    setResponseStatus(null);
    setMessage(null);

    if (intent === "join" && !roomCodeSchema.safeParse(roomCode).success) {
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
        const existingMembership = await fetchRoomMembership(roomCode);
        if (existingMembership !== null) {
          void navigate(getRoomContract.pathFor(roomCode));
          return;
        }
      }

      const request = contract.request.safeParse({ name });
      if (!request.success) {
        setMessage("ニックネームを1〜10文字で入力してください。");
        return;
      }

      const path = intent === "join" ? joinRoomContract.pathFor(roomCode) : createRoomContract.path;
      const response = await fetch(`/api${path}`, {
        method: contract.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.data),
      });
      const body: unknown = await response.json();

      if (response.status === (intent === "join" ? 200 : 201)) {
        const result = contract.response.parse(body);
        if (intent === "join" && result.room.id !== roomCode) {
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

  return (
    <>
      <p>APIステータス：{apiStatus}</p>
      <form onSubmit={(event) => void submitRoom(event)}>
        <label htmlFor="nickname">ニックネーム</label>
        <input id="nickname" value={name} onChange={(event) => setName(event.target.value)} />
        <button type="submit" value="create" disabled={isSubmitting !== null}>
          {isSubmitting === "create" ? "作成中" : "ルーム作成"}
        </button>
        <label htmlFor="room-code">部屋番号</label>
        <input
          id="room-code"
          inputMode="numeric"
          value={roomCode}
          onChange={(event) => setRoomCode(event.target.value)}
        />
        <button type="submit" value="join" disabled={isSubmitting !== null}>
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
    </>
  );
}
