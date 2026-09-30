import {
  leaveRoomContract,
  reportContract,
  roomSocketContract,
  viewerContract,
  chatTextSchema,
  membershipTokenSchema,
  type ChatMessage,
  type CpuLevel,
  type LastRound,
  type Room,
  type RoomMembership,
  type RoomMode,
} from "@tetraboard/protocol";
import { getLegalMoves, type Color, type Position } from "@tetraboard/four-reversi";
import { useEffect, useRef, useState, type FormEvent } from "react";
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

function GameResultView({ lastRound }: { lastRound: LastRound }) {
  const { result } = lastRound.game;
  const playerName = (color: Color) =>
    lastRound.players.find((player) => player.color === color)?.name ?? colorNames[color];

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
      return "この操作はホストだけが行えます。";
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
    case "time_expired":
      return "持ち時間が切れました。";
    case "room_full":
      return "このルームは満室です。";
    case "cpu_not_found":
      return "指定したCPUが見つかりません。";
    default:
      return "ルーム操作に失敗しました。再読み込みしてください。";
  }
}

function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function playerClockText(room: Room, color: Color, serverNowMs: number): string | null {
  if (room.status !== "playing" || room.game.eliminatedColors.includes(color)) return null;
  const main = room.clock.remainingMainMs[color];
  if (room.game.turn !== color) {
    return main > 0
      ? `残り ${formatClock(main)}`
      : `秒読み ${formatClock(room.settings.timeControl.byoyomiMs)}/手`;
  }
  const remainingMain = Math.max(0, main - Math.max(0, serverNowMs - room.clock.turnStartedAt));
  return remainingMain > 0
    ? `残り ${formatClock(remainingMain)}`
    : `秒読み ${formatClock(room.clock.turnExpiresAt - serverNowMs)}`;
}

function RoomDetail({
  initialRoom,
  initialMembership,
  initialServerNowMs,
}: {
  initialRoom: Room;
  initialMembership: RoomMembership | null;
  initialServerNowMs: number;
}) {
  const navigate = useNavigate();
  const [room, setRoom] = useState(initialRoom);
  const [membership, setMembership] = useState(initialMembership);
  const [connection, setConnection] = useState("接続中");
  const [authenticated, setAuthenticated] = useState(false);
  const [pendingReady, setPendingReady] = useState<boolean | null>(null);
  const [pendingSettings, setPendingSettings] = useState(false);
  const [newCpuLevel, setNewCpuLevel] = useState<CpuLevel>(1);
  const [pendingGameAction, setPendingGameAction] = useState<PendingGameAction | null>(null);
  const [socketError, setSocketError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [hiddenSenders, setHiddenSenders] = useState<string[]>(() => {
    try {
      return JSON.parse(
        sessionStorage.getItem(`tetraboard:hidden:${initialRoom.instanceId}`) ?? "[]",
      ) as string[];
    } catch {
      return [];
    }
  });
  const [clockSync, setClockSync] = useState(() => ({
    serverNowMs: initialServerNowMs,
    receivedAt: performance.now(),
  }));
  const [serverNowMs, setServerNowMs] = useState(initialServerNowMs);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingReadyRef = useRef<boolean | null>(null);
  const pendingSettingsRef = useRef(false);
  const pendingGameActionRef = useRef<PendingGameAction | null>(null);

  useEffect(() => {
    if (room.status !== "playing") return;
    const update = () =>
      setServerNowMs(clockSync.serverNowMs + performance.now() - clockSync.receivedAt);
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [room.status, clockSync]);

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

    function clearPendingSettings(): void {
      pendingSettingsRef.current = false;
      setPendingSettings(false);
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
        const latest = await fetchRoom(initialRoom.id, controller.signal);
        const latestRoom = latest.room;
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
        setClockSync({ serverNowMs: latest.serverNowMs, receivedAt: performance.now() });
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
          clearPendingSettings();
          setClockSync({ serverNowMs: message.data.serverNowMs, receivedAt: performance.now() });
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
              (message.data.room.status === "playing"
                ? message.data.room.game.moveNumber > pending.moveNumber
                : message.data.room.lastRound !== null)) ||
            (pending?.type === "resign" &&
              (message.data.room.status === "playing"
                ? message.data.room.game.eliminatedColors.includes(pending.color)
                : message.data.room.lastRound !== null))
          ) {
            clearPendingGameAction();
          }
          return;
        }

        if (message.data.type === "room.chat.snapshot") {
          setChatMessages(message.data.messages);
          return;
        }
        if (message.data.type === "room.chat.error") {
          setChatError(
            message.data.error === "rate_limited"
              ? "3秒おいてから送信してください。"
              : message.data.error === "muted"
                ? "このルームでは送信を停止されています。"
                : "チャットを送信できませんでした。",
          );
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
        clearPendingSettings();
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
        clearPendingSettings();
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
  const canManageSettings =
    room.status === "waiting" &&
    membership?.role === "host" &&
    authenticated &&
    connection === "接続済み" &&
    !pendingSettings;
  const game = room.status === "waiting" ? null : room.game;
  const displayGame = room.status === "playing" ? room.game : (room.lastRound?.game ?? null);
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

  function sendSettingsMessage(message: unknown): void {
    const currentSocket = socketRef.current;
    if (
      !canManageSettings ||
      pendingSettingsRef.current ||
      currentSocket?.readyState !== WebSocket.OPEN
    )
      return;
    pendingSettingsRef.current = true;
    setPendingSettings(true);
    setSocketError(null);
    try {
      currentSocket.send(JSON.stringify(roomSocketContract.clientMessage.parse(message)));
    } catch {
      pendingSettingsRef.current = false;
      setPendingSettings(false);
      setSocketError("ルーム設定を変更できませんでした。");
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

  function handleChatSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = chatTextSchema.safeParse(chatInput);
    if (!parsed.success) {
      setChatError("チャットは1～200文字で、URLは投稿できません。");
      return;
    }
    if (!authenticated || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify(
        roomSocketContract.clientMessage.parse({ type: "room.chat.send", text: parsed.data }),
      ),
    );
    setChatInput("");
    setChatError(null);
  }

  function toggleSender(senderId: string): void {
    const updated = hiddenSenders.includes(senderId)
      ? hiddenSenders.filter((id) => id !== senderId)
      : [...hiddenSenders, senderId];
    setHiddenSenders(updated);
    try {
      sessionStorage.setItem(`tetraboard:hidden:${room.instanceId}`, JSON.stringify(updated));
    } catch {
      /* 保存できない場合も現在の画面では反映します。 */
    }
  }

  async function handleReport(messageId: string): Promise<void> {
    if (reporting !== null) return;
    setReporting(messageId);
    setChatError(null);
    try {
      let token = membership === null ? null : readRoomMembershipToken(room.id);
      if (token === null) {
        const key = `tetraboard:viewer:${room.instanceId}`;
        try {
          token = sessionStorage.getItem(key);
        } catch {
          /* 保存できない場合は新たに発行します。 */
        }
        if (token === null || !membershipTokenSchema.safeParse(token).success) {
          const issued = await fetch(`/api${viewerContract.pathFor(room.id)}`, {
            method: viewerContract.method,
          });
          if (!issued.ok) throw new Error("Viewer token failed");
          token = viewerContract.response.parse(await issued.json()).token;
          try {
            sessionStorage.setItem(key, token);
          } catch {
            /* 現在の通報には発行済みの資格を使います。 */
          }
        }
      }
      const response = await fetch(`/api${reportContract.pathFor(room.id)}`, {
        method: reportContract.method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(reportContract.request.parse({ messageId })),
      });
      if (!response.ok) throw new Error("Report failed");
      reportContract.response.parse(await response.json());
      setChatError("通報を受け付けました。");
    } catch {
      setChatError("通報できませんでした。時間をおいて再度お試しください。");
    } finally {
      setReporting(null);
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
      <p>ゲーム：四人リバーシ</p>
      <p>
        持ち時間：{room.settings.timeControl.mainTimeMs / 60_000}分＋1手
        {room.settings.timeControl.byoyomiMs / 1000}秒
      </p>
      {room.status === "waiting" && membership?.role === "host" ? (
        <>
          <label htmlFor="room-mode">対局モード</label>
          <select
            id="room-mode"
            value={room.settings.mode}
            disabled={!canManageSettings}
            onChange={(event) =>
              sendSettingsMessage({ type: "room.mode.set", mode: event.target.value as RoomMode })
            }
          >
            <option value="singles">シングルス</option>
            <option value="doubles">ダブルス</option>
          </select>
        </>
      ) : (
        <p>対局モード：{room.settings.mode === "singles" ? "シングルス" : "ダブルス"}</p>
      )}
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
      {room.status === "waiting" && membership?.role === "host" && (
        <div>
          <label htmlFor="new-cpu-level">追加するCPUのレベル</label>
          <select
            id="new-cpu-level"
            value={newCpuLevel}
            onChange={(event) => setNewCpuLevel(Number(event.target.value) as CpuLevel)}
            disabled={!canManageSettings}
          >
            <option value={1}>レベル1（よわい）</option>
            <option value={2}>レベル2（ふつう）</option>
          </select>
          <button
            type="button"
            disabled={!canManageSettings || room.players.length >= 4}
            onClick={() => sendSettingsMessage({ type: "room.cpu.add", level: newCpuLevel })}
          >
            CPUを追加
          </button>
        </div>
      )}
      <h2>プレイヤー</h2>
      <ul>
        {room.players.map((player) => (
          <li key={player.id}>
            {membership?.playerId === player.id && "[あなた] "}
            {player.name} ({player.id}) {player.kind === "cpu" && ` CPU レベル${player.level}`}{" "}
            {room.status === "waiting" && player.ready && "✅"}
            {player.color !== null && ` ${colorNames[player.color]}`}
            {player.reconnectDeadline !== null && " 復帰待ち"}
            {room.status !== "waiting" &&
              player.color !== null &&
              room.game.eliminatedColors.includes(player.color) &&
              " 脱落"}
            {player.color !== null &&
              playerClockText(room, player.color, serverNowMs) !== null &&
              ` ${playerClockText(room, player.color, serverNowMs)}`}
            {room.status === "waiting" && membership?.role === "host" && player.kind === "cpu" && (
              <>
                <select
                  aria-label={`${player.name}のレベル`}
                  value={player.level}
                  disabled={!canManageSettings}
                  onChange={(event) =>
                    sendSettingsMessage({
                      type: "room.cpu.level.set",
                      playerId: player.id,
                      level: Number(event.target.value),
                    })
                  }
                >
                  <option value={1}>レベル1</option>
                  <option value={2}>レベル2</option>
                </select>
                <button
                  type="button"
                  disabled={!canManageSettings}
                  onClick={() =>
                    sendSettingsMessage({ type: "room.cpu.remove", playerId: player.id })
                  }
                >
                  {player.name}を削除
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {room.status === "waiting" && room.lastRound !== null && (
        <GameResultView lastRound={room.lastRound} />
      )}
      {displayGame !== null && (
        <>
          <p>
            {room.status === "waiting"
              ? "前局は終了しました。再戦待機中です。"
              : `手番：${room.game.turn ? colorNames[room.game.turn] : ""}`}
          </p>
          {canPlay && (
            <button type="button" onClick={handleResignClick} disabled={pendingGameAction !== null}>
              投了
            </button>
          )}
          <p>着手数：{displayGame.moveNumber}</p>
          {displayGame.consecutivePasses.length > 0 && (
            <p>
              自動パス：
              {displayGame.consecutivePasses.map((color) => colorNames[color]).join(" → ")}
            </p>
          )}
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
              {displayGame.board.map((row, y) => (
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
      <section aria-label="ルームチャット">
        <h2>チャット</h2>
        {chatError && <p>{chatError}</p>}
        <ul>
          {chatMessages.map((message) => (
            <li key={message.id}>
              {hiddenSenders.includes(message.senderId)
                ? `${message.senderName}の発言を非表示中`
                : `${message.senderName}: ${message.text}`}
              <button type="button" onClick={() => toggleSender(message.senderId)}>
                {hiddenSenders.includes(message.senderId) ? "表示" : "非表示"}
              </button>
              <button
                type="button"
                disabled={reporting !== null}
                onClick={() => void handleReport(message.id)}
              >
                通報
              </button>
            </li>
          ))}
        </ul>
        {membership !== null && (
          <form onSubmit={handleChatSubmit}>
            <label htmlFor="chat-message">メッセージ</label>
            <input
              id="chat-message"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
            />
            <button type="submit" disabled={!authenticated || connection !== "接続済み"}>
              送信
            </button>
          </form>
        )}
      </section>
    </>
  );
}

export function RoomPage() {
  const { room, membership, serverNowMs } = useLoaderData<RoomLoaderData>();
  return (
    <RoomDetail
      key={`${room.id}:${membership?.playerId ?? "spectator"}`}
      initialRoom={room}
      initialMembership={membership}
      initialServerNowMs={serverNowMs}
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
