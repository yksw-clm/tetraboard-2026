import { roomSocketContract, type Room, type RoomMembership } from "@tetraboard/protocol";
import { useEffect, useState } from "react";
import { isRouteErrorResponse, Link, useLoaderData, useRouteError } from "react-router";
import { fetchRoomMembership } from "./roomMembership";
import { fetchRoom, type RoomLoaderData } from "./roomLoader";

function RoomDetail({
  initialRoom,
  initialMembership,
}: {
  initialRoom: Room;
  initialMembership: RoomMembership | null;
}) {
  const [room, setRoom] = useState(initialRoom);
  const [membership, setMembership] = useState(initialMembership);
  const [connection, setConnection] = useState("接続中");

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;

    function scheduleReconnect(): void {
      if (!active) return;
      setConnection("再接続中");
      timer = setTimeout(() => void reconnect(), retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    }

    async function reconnect(): Promise<void> {
      controller = new AbortController();
      try {
        const latestRoom = await fetchRoom(initialRoom.id, controller.signal);
        const latestMembership = await fetchRoomMembership(initialRoom.id, controller.signal);
        if (!active) return;
        setRoom(latestRoom);
        setMembership(latestMembership);
        connect();
      } catch (error) {
        if (!active) return;
        if (error instanceof Response && error.status === 404) {
          setConnection("ルームが見つかりません");
          return;
        }
        scheduleReconnect();
      }
    }

    function connect(): void {
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${scheme}//${window.location.host}/api${roomSocketContract.pathFor(initialRoom.id)}`;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }

      const currentSocket = socket;
      currentSocket.onmessage = (event: MessageEvent) => {
        let body: unknown;
        try {
          body = JSON.parse(event.data as string);
        } catch {
          currentSocket.close(1003, "Invalid room message");
          return;
        }
        const message = roomSocketContract.message.safeParse(body);
        if (!message.success || message.data.room.id !== initialRoom.id) {
          currentSocket.close(1003, "Invalid room message");
          return;
        }
        if (active) {
          setRoom(message.data.room);
          setConnection("接続済み");
          retryDelay = 1000;
        }
      };
      currentSocket.onerror = () => currentSocket.close();
      currentSocket.onclose = () => scheduleReconnect();
    }

    connect();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
      socket?.close();
    };
  }, [initialRoom.id]);

  return (
    <>
      <p>
        <Link to="/">トップへ</Link>
      </p>
      <h1>ルーム {room.id}</h1>
      <p>
        参加区分：{membership?.role === "host" ? "ホスト" : membership ? "プレイヤー" : "観戦者"}
      </p>
      <p>接続状態：{connection}</p>
      <p>状態：{room.status}</p>
      <h2>プレイヤー</h2>
      <ul>
        {room.players.map((player) => (
          <li key={player.id}>
            {membership?.playerId === player.id && "[あなた] "}
            {player.name} ({player.id})
          </li>
        ))}
      </ul>
    </>
  );
}

export function RoomPage() {
  const { room, membership } = useLoaderData<RoomLoaderData>();
  return (
    <RoomDetail
      key={`${room.id}:${membership?.playerId ?? "spectator"}`}
      initialRoom={room}
      initialMembership={membership}
    />
  );
}

export function RoomErrorPage() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? error.status === 404
      ? "ルームが見つかりません。"
      : error.status === 400
        ? "ルームIDが不正です。"
        : error.status === 503
          ? "本人確認ができませんでした。再読み込みしてください。"
          : "ルーム情報を取得できませんでした。"
    : "ルーム情報を取得できませんでした。";

  return (
    <>
      <p>{message}</p>
      <p>
        <Link to="/">トップへ</Link>
      </p>
    </>
  );
}
