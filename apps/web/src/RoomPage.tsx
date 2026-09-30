import {
  leaveRoomContract,
  roomSocketContract,
  type Room,
  type RoomMembership,
} from "@tetraboard/protocol";
import { getLegalMoves, type Color, type Position } from "@tetraboard/four-reversi";
import { useEffect, useRef, useState } from "react";
import {
  isRouteErrorResponse,
  Link,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "react-router";
import {
  clearRoomMembershipToken,
  fetchRoomMembership,
  readRoomMembershipToken,
} from "./roomMembership";
import { fetchRoom, type RoomLoaderData } from "./roomLoader";

const colorNames: Record<Color, string> = {
  black: "黒",
  white: "白",
  red: "赤",
  blue: "青",
};
const endReasonNames = {
  board_full: "盤面が埋まったため",
  all_passed: "全員が連続して自動パスしたため",
  last_player: "最後の1人になったため",
  team_eliminated: "チームのプレイヤーが脱落したため",
} as const;
const teamNames = { "black-red": "黒・赤チーム", "white-blue": "白・青チーム" } as const;
const columns = "ABCDEFGH";
type PendingGameAction =
  | { type: "start" }
  | { type: "move"; moveNumber: number }
  | { type: "resign"; color: Color };

function GameResultView({ room }: { room: Extract<Room, { status: "finished" }> }) {
  const { result } = room.game;
  const playerName = (color: Color) =>
    room.players.find((player) => player.color === color)?.name ?? colorNames[color];

  return (
    <section aria-label="対局結果">
      <h2>対局結果</h2>
      <p>終局理由：{endReasonNames[result.reason]}</p>
      {result.mode === "singles" ? (
        <ul>
          {result.standings.map((standing) => (
            <li key={standing.color}>
              {standing.rank}位：{playerName(standing.color)}（{colorNames[standing.color]}）
              {standing.stoneCount === undefined ? " 脱落" : ` ${standing.stoneCount}石`}
            </li>
          ))}
        </ul>
      ) : (
        <>
          <p>勝敗：{result.winner === null ? "引き分け" : `${teamNames[result.winner]}の勝ち`}</p>
          {result.teamTotals !== null && (
            <p>
              黒・赤チーム {result.teamTotals["black-red"]}石、白・青チーム{" "}
              {result.teamTotals["white-blue"]}石
            </p>
          )}
          <ul>
            {result.stoneCounts.map(({ color, count }) => (
              <li key={color}>
                {playerName(color)}（{colorNames[color]}） {count}石
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function operationErrorMessage(error: string): string {
  switch (error) {
    case "not_ready":
      return "4人全員の準備完了が必要です。";
    case "forbidden":
      return "対局を開始できるのはホストだけです。";
    case "already_started":
      return "対局はすでに始まっています。";
    case "game_not_started":
      return "対局はまだ始まっていません。";
    case "game_finished":
      return "対局は終了しています。";
    case "not_your_turn":
      return "現在はあなたの手番ではありません。";
    case "invalid_move":
      return "その場所には石を置けません。";
    case "already_eliminated":
      return "すでに脱落しています。";
    default:
      return "ルーム操作に失敗しました。再読み込みしてください。";
  }
}

function RoomDetail({
  initialRoom,
  initialMembership,
}: {
  initialRoom: Room;
  initialMembership: RoomMembership | null;
}) {
  const navigate = useNavigate();
  const [room, setRoom] = useState(initialRoom);
  const [membership, setMembership] = useState(initialMembership);
  const [connection, setConnection] = useState("接続中");
  const [authenticated, setAuthenticated] = useState(false);
  const [pendingReady, setPendingReady] = useState<boolean | null>(null);
  const [pendingGameAction, setPendingGameAction] = useState<PendingGameAction | null>(null);
  const [socketError, setSocketError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingReadyRef = useRef<boolean | null>(null);
  const pendingGameActionRef = useRef<PendingGameAction | null>(null);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;
    let currentMembership = initialMembership;

    function clearPendingReady(): void {
      pendingReadyRef.current = null;
      setPendingReady(null);
    }

    function clearPendingGameAction(): void {
      pendingGameActionRef.current = null;
      setPendingGameAction(null);
    }

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
        if (
          latestMembership !== null &&
          !latestRoom.players.some((player) => player.id === latestMembership.playerId)
        ) {
          throw new Error("Membership does not match room");
        }
        currentMembership = latestMembership;
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
      setAuthenticated(false);
      setSocketError(null);
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${scheme}//${window.location.host}/api${roomSocketContract.pathFor(initialRoom.id)}`;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }

      const currentSocket = socket;
      socketRef.current = currentSocket;
      currentSocket.onopen = () => {
        if (!active || currentMembership === null) return;
        const token = readRoomMembershipToken(initialRoom.id);
        if (token === null) {
          currentMembership = null;
          setMembership(null);
          return;
        }
        currentSocket.send(
          JSON.stringify(roomSocketContract.clientMessage.parse({ type: "room.auth", token })),
        );
      };
      currentSocket.onmessage = (event: MessageEvent) => {
        let body: unknown;
        try {
          body = JSON.parse(event.data as string);
        } catch {
          currentSocket.close(1003, "Invalid room message");
          return;
        }
        const message = roomSocketContract.message.safeParse(body);
        if (!message.success) {
          currentSocket.close(1003, "Invalid room message");
          return;
        }
        if (!active) return;

        if (message.data.type === "room.snapshot") {
          if (message.data.room.id !== initialRoom.id) {
            currentSocket.close(1003, "Invalid room message");
            return;
          }
          setRoom(message.data.room);
          setConnection("接続済み");
          retryDelay = 1000;
          if (
            pendingReadyRef.current !== null &&
            message.data.room.players.find((player) => player.id === currentMembership?.playerId)
              ?.ready === pendingReadyRef.current
          ) {
            clearPendingReady();
          }
          const pending = pendingGameActionRef.current;
          if (
            (pending?.type === "start" && message.data.room.status === "playing") ||
            (pending?.type === "move" &&
              message.data.room.status !== "waiting" &&
              message.data.room.game.moveNumber > pending.moveNumber) ||
            (pending?.type === "resign" &&
              message.data.room.status !== "waiting" &&
              message.data.room.game.eliminatedColors.includes(pending.color))
          ) {
            clearPendingGameAction();
          }
          return;
        }

        if (message.data.type === "room.authenticated") {
          if (
            currentMembership === null ||
            message.data.membership.playerId !== currentMembership.playerId
          ) {
            setAuthenticated(false);
            setSocketError("WebSocketの本人確認結果が一致しません。再読み込みしてください。");
            return;
          }
          currentMembership = message.data.membership;
          setMembership(message.data.membership);
          setAuthenticated(true);
          setSocketError(null);
          return;
        }

        clearPendingReady();
        clearPendingGameAction();
        if (message.data.error === "unauthorized") {
          setAuthenticated(false);
          setSocketError("参加資格を確認できませんでした。再読み込みしてください。");
          void fetchRoomMembership(initialRoom.id)
            .then((latestMembership) => {
              if (!active) return;
              currentMembership = latestMembership;
              setMembership(latestMembership);
            })
            .catch(() => {
              if (active) setSocketError("本人確認に失敗しました。再読み込みしてください。");
            });
        } else {
          setSocketError(operationErrorMessage(message.data.error));
        }
      };
      currentSocket.onerror = () => currentSocket.close();
      currentSocket.onclose = () => {
        if (socketRef.current === currentSocket) socketRef.current = null;
        if (!active) return;
        setAuthenticated(false);
        clearPendingReady();
        clearPendingGameAction();
        scheduleReconnect();
      };
    }

    connect();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
      socketRef.current = null;
      socket?.close();
    };
  }, [initialRoom.id, initialMembership]);

  const self = room.players.find((player) => player.id === membership?.playerId);
  const game = room.status === "waiting" ? null : room.game;
  const legalMoves = game === null ? [] : getLegalMoves(game);
  const canPlay =
    game?.status === "playing" &&
    self?.color === game.turn &&
    !game.eliminatedColors.includes(game.turn) &&
    authenticated &&
    connection === "接続済み" &&
    pendingGameAction === null;

  function sendGameMessage(message: unknown, pending: PendingGameAction): void {
    const currentSocket = socketRef.current;
    if (
      !authenticated ||
      pendingGameActionRef.current !== null ||
      currentSocket?.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    pendingGameActionRef.current = pending;
    setPendingGameAction(pending);
    setSocketError(null);
    try {
      currentSocket.send(JSON.stringify(roomSocketContract.clientMessage.parse(message)));
    } catch {
      pendingGameActionRef.current = null;
      setPendingGameAction(null);
      setSocketError("対局操作を送信できませんでした。");
    }
  }

  function handleStartClick(): void {
    if (
      room.status !== "waiting" ||
      membership?.role !== "host" ||
      room.players.length !== 4 ||
      room.players.some((player) => !player.ready)
    ) {
      return;
    }
    sendGameMessage({ type: "room.game.start" }, { type: "start" });
  }

  function handlePlaceStone(position: Position): void {
    if (
      !canPlay ||
      game === null ||
      !legalMoves.some((move) => move.x === position.x && move.y === position.y)
    ) {
      return;
    }
    sendGameMessage(
      { type: "room.game.action", action: { type: "placeStone", position } },
      { type: "move", moveNumber: game.moveNumber },
    );
  }

  function handleReadyClick(): void {
    const currentSocket = socketRef.current;
    if (
      self === undefined ||
      !authenticated ||
      pendingReadyRef.current !== null ||
      currentSocket?.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    const ready = !self.ready;
    pendingReadyRef.current = ready;
    setPendingReady(ready);
    setSocketError(null);
    try {
      currentSocket.send(
        JSON.stringify(roomSocketContract.clientMessage.parse({ type: "room.ready.set", ready })),
      );
    } catch {
      pendingReadyRef.current = null;
      setPendingReady(null);
      setSocketError("準備状態を送信できませんでした。");
    }
  }

  function handleResignClick(): void {
    if (!canPlay || self?.color === null || self?.color === undefined) return;
    sendGameMessage({ type: "room.game.resign" }, { type: "resign", color: self.color });
  }

  async function handleLeaveClick(): Promise<void> {
    if (membership === null || leaving) return;
    const token = readRoomMembershipToken(room.id);
    if (token === null) {
      setSocketError("参加資格が見つかりません。再読み込みしてください。");
      return;
    }
    setLeaving(true);
    setSocketError(null);
    try {
      const response = await fetch(`/api${leaveRoomContract.pathFor(room.id)}`, {
        method: leaveRoomContract.method,
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status !== 204 && response.status !== 401 && response.status !== 404) {
        throw new Error("Room leave failed");
      }
      clearRoomMembershipToken(room.id);
      void navigate("/");
    } catch {
      setSocketError("退室できませんでした。再度お試しください。");
      setLeaving(false);
    }
  }

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
      {socketError && <p>{socketError}</p>}
      <p>状態：{room.status}</p>
      {membership !== null && (
        <button type="button" disabled={leaving} onClick={() => void handleLeaveClick()}>
          退室
        </button>
      )}
      {membership !== null && self !== undefined && room.status === "waiting" && (
        <button
          type="button"
          onClick={handleReadyClick}
          disabled={!authenticated || connection !== "接続済み" || pendingReady !== null}
        >
          {self.ready ? "準備取消" : "準備完了"}
        </button>
      )}
      {room.status === "waiting" && membership?.role === "host" && (
        <button
          type="button"
          onClick={handleStartClick}
          disabled={
            !authenticated ||
            connection !== "接続済み" ||
            room.players.length !== 4 ||
            room.players.some((player) => !player.ready || player.reconnectDeadline !== null) ||
            pendingGameAction !== null
          }
        >
          対局開始
        </button>
      )}
      <h2>プレイヤー</h2>
      <ul>
        {room.players.map((player) => (
          <li key={player.id}>
            {membership?.playerId === player.id && "[あなた] "}
            {player.name} ({player.id}) {room.status === "waiting" && player.ready && "✅"}
            {player.color !== null && ` ${colorNames[player.color]}`}
            {player.reconnectDeadline !== null && " 復帰待ち"}
            {room.status !== "waiting" &&
              player.color !== null &&
              room.game.eliminatedColors.includes(player.color) &&
              " 脱落"}
          </li>
        ))}
      </ul>
      {game !== null && (
        <>
          <p>{game.status === "finished" ? "対局終了" : `手番：${colorNames[game.turn]}`}</p>
          {canPlay && (
            <button type="button" onClick={handleResignClick} disabled={pendingGameAction !== null}>
              投了
            </button>
          )}
          <p>着手数：{game.moveNumber}</p>
          {game.consecutivePasses.length > 0 && (
            <p>自動パス：{game.consecutivePasses.map((color) => colorNames[color]).join(" → ")}</p>
          )}
          {room.status === "finished" && <GameResultView room={room} />}
          <table>
            <thead>
              <tr>
                <th></th>
                {[...columns].map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {game.board.map((row, y) => (
                <tr key={y}>
                  <th>{y + 1}</th>
                  {row.map((cell, x) => {
                    const legal = legalMoves.some((move) => move.x === x && move.y === y);
                    return (
                      <td key={x}>
                        <button
                          type="button"
                          aria-label={`${columns[x]}${y + 1}: ${cell === null ? "空き" : colorNames[cell]}`}
                          disabled={!canPlay || !legal}
                          onClick={() => handlePlaceStone({ x, y })}
                        >
                          {cell === null ? (legal && canPlay ? "＋" : "・") : colorNames[cell]}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
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
