import { roomSnapshotFor } from "./roomSnapshot";
import type { Side } from "@tetraboard/four-shogi";
import {
  roomSocketContract,
  isFourShogiRoom,
  type GameCommandFor,
  type ChatEntry,
  type CpuLevel,
  type Room,
  type RoomMembership,
  type RoomMode,
  type RoomTimeControl,
  type RoomPresence,
} from "@tetraboard/protocol";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { gameCatalog } from "@tetraboard/protocol/games";
import {
  clearRoomMembershipToken,
  fetchRoomMembership,
  readRoomMembershipToken,
} from "../../shared/roomMembership";
import { assertRoomIdentity, roomChangedMessage } from "../../shared/roomAccess";
import { fetchRoom, leaveRoom } from "./roomApi";

const roomClosedMessage = "ルームは閉鎖されています。ロビーへ戻ってください。";

export type PendingGameAction =
  | { type: "start" }
  | { type: "move"; moveNumber: number; roundId?: string; positionRevision?: number }
  | { type: "resign"; participant: string }
  | {
      type: "draw";
      participant: Side;
      proposed: boolean;
      roundId: string;
      positionRevision: number;
    };

function operationErrorMessage(error: string, game: Room["settings"]["game"]): string {
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
      return game === "four-shogi"
        ? "その手は指せません。最新の局面で選び直してください。"
        : "その場所には石を置けません。";
    case "stale_position":
      return "局面が更新されました。最新の局面で選び直してください。";
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

export function useRoomTransport<T extends Room>({
  initialRoom,
  initialMembership,
  initialServerNowMs,
  initialPresence,
  isRoom,
}: {
  initialRoom: T;
  isRoom: (room: Room) => room is T;
  initialMembership: RoomMembership | null;
  initialServerNowMs: number;
  initialPresence: RoomPresence;
}) {
  const navigate = useNavigate();
  const [room, setRoom] = useState(initialRoom);
  const [presence, setPresence] = useState(initialPresence);
  const [membership, setMembership] = useState(initialMembership);
  const [connection, setConnection] = useState("接続中");
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [pendingReady, setPendingReady] = useState<boolean | null>(null);
  const [pendingSettings, setPendingSettings] = useState(false);
  const [newCpuLevel, setNewCpuLevel] = useState<CpuLevel>(1);
  const [pendingGameAction, setPendingGameAction] = useState<PendingGameAction | null>(null);
  const [socketError, setSocketError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatEntry[]>([]);
  const [chatNotifications, setChatNotifications] = useState<ChatEntry[]>([]);
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

    function stopUnavailable(message: string): void {
      active = false;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
      socketRef.current = null;
      socket?.close();
      setAuthenticated(false);
      setUnavailable(message);
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
        const latest = await fetchRoom(initialRoom.id, controller.signal, initialRoom.instanceId);
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
        if (!isRoom(latestRoom)) throw new Error("Room game changed");
        setRoom(latestRoom);
        setPresence(latest.presence);
        setClockSync({ serverNowMs: latest.serverNowMs, receivedAt: performance.now() });
        setMembership(latestMembership);
        connect();
      } catch (error) {
        if (!active) return;
        if (error instanceof Response && (error.status === 404 || error.status === 410)) {
          stopUnavailable(error.status === 410 ? roomChangedMessage : roomClosedMessage);
          return;
        }
        scheduleReconnect();
      }
    }

    function connect(): void {
      setAuthenticated(false);
      setSocketError(null);
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${scheme}//${window.location.host}/api${roomSocketContract.pathFor(initialRoom.id)}?instanceId=${initialRoom.instanceId}`;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }

      const currentSocket = socket;
      let chatIds: Set<string> | null = null;
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
          try {
            assertRoomIdentity(message.data.room, initialRoom.id, initialRoom.instanceId);
          } catch {
            stopUnavailable(roomChangedMessage);
            return;
          }
          const snapshot = roomSnapshotFor(message.data.room, isRoom);
          if (snapshot === null) {
            stopUnavailable(roomChangedMessage);
            return;
          }
          setRoom(snapshot);
          setPresence(message.data.presence);
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
                ? isFourShogiRoom(message.data.room)
                  ? message.data.room.roundId !== pending.roundId ||
                    message.data.room.positionRevision > (pending.positionRevision ?? -1)
                  : message.data.room.game.moveNumber > pending.moveNumber
                : message.data.room.lastRound !== null)) ||
            (pending?.type === "draw" &&
              isFourShogiRoom(message.data.room) &&
              (message.data.room.status === "waiting" ||
                message.data.room.roundId !== pending.roundId ||
                message.data.room.positionRevision > pending.positionRevision ||
                message.data.room.game.drawProposals.includes(pending.participant) ===
                  pending.proposed)) ||
            (pending?.type === "resign" &&
              (message.data.room.status === "playing"
                ? isFourShogiRoom(message.data.room)
                  ? message.data.room.game.eliminations.some(
                      (entry) => entry.side === pending.participant,
                    )
                  : message.data.room.game.eliminatedColors.some(
                      (color) => color === pending.participant,
                    )
                : message.data.room.lastRound !== null))
          ) {
            clearPendingGameAction();
          }
          return;
        }

        if (message.data.type === "room.chat.snapshot") {
          const incoming = message.data.messages;
          if (chatIds !== null) {
            const added = incoming.filter((entry) => !chatIds!.has(entry.id));
            if (added.length > 0)
              setChatNotifications((previous) => [...previous, ...added].slice(-100));
          }
          chatIds = new Set(incoming.map((entry) => entry.id));
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
            setSocketError("参加資格を確認できませんでした。再読み込みしてください。");
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
        if (message.data.error === "not_found") {
          stopUnavailable(roomClosedMessage);
          return;
        }
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
          setSocketError(operationErrorMessage(message.data.error, initialRoom.settings.game));
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
  }, [
    initialRoom.id,
    initialRoom.instanceId,
    initialRoom.settings.game,
    initialMembership,
    isRoom,
  ]);

  const self = room.players.find((player) => player.id === membership?.playerId);
  const canManageSettings =
    room.status === "waiting" &&
    membership?.role === "host" &&
    authenticated &&
    connection === "接続済み" &&
    !pendingSettings;
  function sendGameMessage(
    message: GameCommandFor<T["settings"]["game"]>,
    pending: PendingGameAction,
  ): void {
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
      room.players.some(
        (player) => !player.ready || !presence.connectedPlayerIds.includes(player.id),
      )
    ) {
      return;
    }
    sendGameMessage({ type: "room.game.start" }, { type: "start" });
  }

  function handleReadyClick(): void {
    const currentSocket = socketRef.current;
    if (
      self === undefined ||
      room.status !== "waiting" ||
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
      void navigate(gameCatalog[room.settings.game].lobbyPath);
    } catch {
      setSocketError("退室できませんでした。再度お試しください。");
      setLeaving(false);
    }
  }

  function sendChat(text: string): boolean {
    if (!authenticated || socketRef.current?.readyState !== WebSocket.OPEN) return false;
    try {
      socketRef.current.send(
        JSON.stringify(roomSocketContract.clientMessage.parse({ type: "room.chat.send", text })),
      );
      setChatError(null);
      return true;
    } catch {
      setChatError("送信できませんでした。接続を確認して、もう一度お試しください。");
      return false;
    }
  }

  function clearChatError(): void {
    setChatError(null);
  }

  return {
    room,
    unavailable,
    presence,
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
    chatNotifications,
    chatError,
    clearChatError,
    sendChat,
    serverNowMs,
    self,
    canManageSettings,
    sendGameMessage,
    handleStartClick,
    handleReadyClick,
    changeMode,
    changeTimeControl: (timeControl: RoomTimeControl) =>
      sendSettingsMessage({ type: "room.time-control.set", timeControl }),
    changeThreePlayerAttack: (prohibited: boolean) =>
      sendSettingsMessage({ type: "room.three-player-attack.set", prohibited }),
    addCpu,
    changeCpuLevel,
    removeCpu,
    handleLeaveClick,
  };
}
