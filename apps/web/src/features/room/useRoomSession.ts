import {
  roomSocketContract,
  type ChatMessage,
  type CpuLevel,
  type Room,
  type RoomMembership,
  type RoomMode,
} from "@tetraboard/protocol";
import { getLegalMoves, type Color, type Position } from "@tetraboard/four-reversi";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { fourReversiLobbyPath } from "../../app/paths";
import {
  clearRoomMembershipToken,
  fetchRoomMembership,
  readRoomMembershipToken,
} from "../../shared/roomMembership";
import { fetchRoom, leaveRoom } from "./roomApi";

type PendingGameAction =
  | { type: "start" }
  | { type: "move"; moveNumber: number }
  | { type: "resign"; color: Color };

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

export function useRoomSession({
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
  const [chatError, setChatError] = useState<string | null>(null);
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

  function changeMode(mode: RoomMode): void {
    sendSettingsMessage({ type: "room.mode.set", mode });
  }

  function addCpu(level: CpuLevel): void {
    sendSettingsMessage({ type: "room.cpu.add", level });
  }

  function changeCpuLevel(playerId: string, level: CpuLevel): void {
    sendSettingsMessage({ type: "room.cpu.level.set", playerId, level });
  }

  function removeCpu(playerId: string): void {
    sendSettingsMessage({ type: "room.cpu.remove", playerId });
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
      await leaveRoom(room.id, token);
      clearRoomMembershipToken(room.id);
      void navigate(fourReversiLobbyPath);
    } catch {
      setSocketError("退室できませんでした。再度お試しください。");
      setLeaving(false);
    }
  }

  function sendChat(text: string): boolean {
    if (!authenticated || socketRef.current?.readyState !== WebSocket.OPEN) return false;
    socketRef.current.send(
      JSON.stringify(roomSocketContract.clientMessage.parse({ type: "room.chat.send", text })),
    );
    setChatError(null);
    return true;
  }

  function clearChatError(): void {
    setChatError(null);
  }

  return {
    room,
    membership,
    connection,
    authenticated,
    pendingReady,
    newCpuLevel,
    setNewCpuLevel,
    pendingGameAction,
    socketError,
    leaving,
    chatMessages,
    chatError,
    clearChatError,
    sendChat,
    serverNowMs,
    self,
    canManageSettings,
    displayGame,
    legalMoves,
    canPlay,
    handleStartClick,
    handlePlaceStone,
    handleReadyClick,
    changeMode,
    addCpu,
    changeCpuLevel,
    removeCpu,
    handleResignClick,
    handleLeaveClick,
  };
}
