import {
  createRoomContract,
  getRoomContract,
  healthzContract,
  type RoomError,
} from "@tetraboard/protocol";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";

type ApiStatus = "確認中" | "OK" | "接続失敗";

export function App() {
  const navigate = useNavigate();
  const [apiStatus, setApiStatus] = useState<ApiStatus>("確認中");
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [roomResponse, setRoomResponse] = useState<RoomError | null>(null);
  const [responseStatus, setResponseStatus] = useState<number | null>(null);
  const [creationMessage, setCreationMessage] = useState<string | null>(null);

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

  async function createRoom(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const request = createRoomContract.request.safeParse({ name });
    setRoomResponse(null);
    setResponseStatus(null);
    setCreationMessage(null);

    if (!request.success) {
      setCreationMessage("ニックネームを1〜10文字で入力してください。");
      return;
    }

    setIsCreating(true);

    try {
      const response = await fetch(`/api${createRoomContract.path}`, {
        method: createRoomContract.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.data),
      });
      const body: unknown = await response.json();

      if (response.status === 201) {
        const room = createRoomContract.response.parse(body);
        void navigate(getRoomContract.pathFor(room.id));
      } else {
        setRoomResponse(createRoomContract.error.parse(body));
        setResponseStatus(response.status);
      }
    } catch {
      setCreationMessage("ルーム作成の応答を確認できませんでした。");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <>
      <p>APIステータス：{apiStatus}</p>
      <form onSubmit={(event) => void createRoom(event)}>
        <label htmlFor="nickname">ニックネーム</label>
        <input id="nickname" value={name} onChange={(event) => setName(event.target.value)} />
        <button type="submit" disabled={isCreating}>
          {isCreating ? "作成中" : "ルーム作成"}
        </button>
      </form>
      {creationMessage && <p role="status">{creationMessage}</p>}
      {roomResponse && (
        <section aria-label="ルーム作成の応答">
          <p>HTTP {responseStatus}</p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(roomResponse, null, 2)}
          </pre>
        </section>
      )}
    </>
  );
}
