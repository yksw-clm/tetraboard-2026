import { roomSnapshotFor } from "./roomSnapshot";
import type { GameSettingsCommandFor, PendingActionFor } from "./gameSessionTypes";
import {
  roomSocketContract,
  type GameCommandFor,
  type ChatEntry,
  type CpuLevel,
  type Room,
  type RoomMembership,
  type RoomMode,
  type RoomTimeControl,
  type RoomPresence,
  type RoomSocketClientMessage,
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
import { roomSounds, useSoundEffects } from "../../shared/soundEffects";
import { RoomSoundTracker, type SoundGameState } from "./roomSoundEvents";

const roomClosedMessage = "ルームは閉鎖されています。ロビーへ戻ってください。";

type PendingOperation<P> = { type: "start" } | { type: "game"; action: P };
type CommonSettingsCommand = Extract<
  RoomSocketClientMessage,
  {
    type:
      | "room.mode.set"
      | "room.time-control.set"
      | "room.cpu.add"
      | "room.cpu.level.set"
      | "room.cpu.remove";
  }
>;

export interface RoomTransportOptions<T extends Room> {
  initialRoom: T;
  isRoom: (room: Room) => room is T;
  actionComplete: (room: T, pending: PendingActionFor<T["settings"]["game"]>) => boolean;
  gameOperationError: (error: string) => string | undefined;
  readSoundGame: (room: T) => SoundGameState;
  initialMembership: RoomMembership | null;
  initialServerNowMs: number;
  initialPresence: RoomPresence;
  initialFormationAnalysisSupported?: boolean;
}

export type SharedRoomSession = Omit<
  ReturnType<typeof useRoomTransport>,
  "sendGameMessage" | "sendGameSettingsMessage" | "playOwnMove"
>;

function operationErrorMessage(
  error: string,
  gameError: (error: string) => string | undefined,
): string {
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
    case "already_eliminated":
      return "すでに脱落しています。";
    case "time_expired":
      return "持ち時間が切れました。";
    case "room_full":
      return "このルームは満室です。";
    case "cpu_not_found":
      return "指定したCPUが見つかりません。";
    default:
      return gameError(error) ?? "ルーム操作に失敗しました。再読み込みしてください。";
  }
}

export function useRoomTransport<T extends Room>({
  initialRoom,
  initialMembership,
  initialServerNowMs,
  initialPresence,
  isRoom,
  actionComplete,
  gameOperationError,
  readSoundGame,
  initialFormationAnalysisSupported = false,
}: RoomTransportOptions<T>) {
  useSoundEffects();
  const navigate = useNavigate();
  const [room, setRoom] = useState(initialRoom);
  const [presence, setPresence] = useState(initialPresence);
  const [membership, setMembership] = useState(initialMembership);
  const [connection, setConnection] = useState("接続中");
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [pendingReady, setPendingReady] = useState<boolean | null>(null);
  const [pendingSettings, setPendingSettings] = useState(false);
  const [pendingSettingsCommand, setPendingSettingsCommand] = useState<
    CommonSettingsCommand | GameSettingsCommandFor<T["settings"]["game"]> | null
  >(null);
  const [newCpuLevel, setNewCpuLevel] = useState<CpuLevel>(1);
  const [pendingGameAction, setPendingGameAction] = useState<PendingOperation<
    PendingActionFor<T["settings"]["game"]>
  > | null>(null);
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
  const soundTrackerRef = useRef<RoomSoundTracker<T> | null>(null);
  const pendingReadyRef = useRef<boolean | null>(null);
  const pendingSettingsRef = useRef(false);
  const pendingGameActionRef = useRef<PendingOperation<
    PendingActionFor<T["settings"]["game"]>
  > | null>(null);

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
    const soundTracker = new RoomSoundTracker(readSoundGame);
    soundTrackerRef.current = soundTracker;
    const releaseSounds = roomSounds.retainRoom(initialRoom.instanceId);
    let soundController: AbortController | null = null;
    let soundGeneration = 0;
    let soundReady = true;
    let soundBaselineAtMs: number | null = null;
    let latestSoundSnapshot: { room: T; serverNowMs: number } | null = null;
    const visibilityChanged = () => {
      soundTracker.reset();
      soundController?.abort();
      const generation = ++soundGeneration;
      soundReady = false;
      if (document.visibilityState !== "visible") return;
      const resumeController = new AbortController();
      soundController = resumeController;
      // 非表示中にブラウザへ溜まった通知も、復帰後にまとめて鳴らしません。
      void fetchRoom(initialRoom.id, resumeController.signal, initialRoom.instanceId)
        .then((latest) => {
          if (!active || generation !== soundGeneration || !isRoom(latest.room)) return;
          const baseline =
            latestSoundSnapshot !== null && latestSoundSnapshot.serverNowMs > latest.serverNowMs
              ? latestSoundSnapshot
              : { room: latest.room, serverNowMs: latest.serverNowMs };
          soundTracker.baseline(baseline.room);
          soundBaselineAtMs = baseline.serverNowMs;
          soundReady = true;
        })
        .catch(() => {
          // 再取得失敗時もゲーム通信は継続し、次の復帰・再接続で基準を作ります。
        });
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    let socket: WebSocket | null = null;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;
    let currentMembership = initialMembership;
    let formationAnalysisSupported = initialFormationAnalysisSupported;

    function clearPendingReady(): void {
      pendingReadyRef.current = null;
      setPendingReady(null);
    }

    function clearPendingSettings(): void {
      pendingSettingsRef.current = false;
      setPendingSettings(false);
      setPendingSettingsCommand(null);
    }

    function clearPendingGameAction(): void {
      soundTracker.clearOwnMove();
      pendingGameActionRef.current = null;
      setPendingGameAction(null);
    }

    function stopUnavailable(message: string): void {
      active = false;
      soundTracker.reset();
      soundController?.abort();
      roomSounds.stop();
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
        formationAnalysisSupported =
          latestRoom.settings.game === "four-shogi" && latest.formationAnalysis !== undefined;
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
      soundTracker.reset();
      soundController?.abort();
      soundGeneration++;
      soundReady = true;
      soundBaselineAtMs = null;
      latestSoundSnapshot = null;
      setAuthenticated(false);
      setSocketError(null);
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${scheme}//${window.location.host}/api${roomSocketContract.pathFor(initialRoom.id)}?instanceId=${initialRoom.instanceId}${formationAnalysisSupported ? "&formationAnalysis=1" : ""}`;
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
        if (!active || currentSocket !== socketRef.current) return;

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
          if (
            latestSoundSnapshot === null ||
            message.data.serverNowMs >= latestSoundSnapshot.serverNowMs
          )
            latestSoundSnapshot = { room: snapshot, serverNowMs: message.data.serverNowMs };
          const sounds =
            !soundReady ||
            (soundBaselineAtMs !== null && message.data.serverNowMs <= soundBaselineAtMs)
              ? []
              : soundTracker.observe(
                  snapshot,
                  soundReady && document.visibilityState === "visible",
                );
          for (const sound of sounds) {
            if (sound.type === "join") roomSounds.playJoin(sound.instanceId, sound.playerId);
            else roomSounds.play(sound.sounds);
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
            (pending?.type === "start" && snapshot.status === "playing") ||
            (pending?.type === "game" && actionComplete(snapshot, pending.action))
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
          setSocketError(operationErrorMessage(message.data.error, gameOperationError));
        }
      };
      currentSocket.onerror = () => currentSocket.close();
      currentSocket.onclose = () => {
        if (socketRef.current === currentSocket) socketRef.current = null;
        if (!active) return;
        soundTracker.reset();
        soundController?.abort();
        soundGeneration++;
        soundReady = false;
        roomSounds.stop();
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
      document.removeEventListener("visibilitychange", visibilityChanged);
      soundTrackerRef.current = null;
      releaseSounds();
      soundController?.abort();
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
      socketRef.current = null;
      socket?.close();
    };
  }, [
    initialFormationAnalysisSupported,
    initialRoom.id,
    initialRoom.instanceId,
    initialRoom.settings.game,
    initialMembership,
    isRoom,
    actionComplete,
    gameOperationError,
    readSoundGame,
  ]);

  const self = room.players.find((player) => player.id === membership?.playerId);
  const canManageSettings =
    room.status === "waiting" &&
    membership?.role === "host" &&
    authenticated &&
    connection === "接続済み" &&
    !pendingSettings;
  function sendGameOperation(
    message: GameCommandFor<T["settings"]["game"]>,
    pending: PendingOperation<PendingActionFor<T["settings"]["game"]>>,
  ): boolean {
    const currentSocket = socketRef.current;
    if (
      !authenticated ||
      pendingGameActionRef.current !== null ||
      currentSocket?.readyState !== WebSocket.OPEN
    ) {
      return false;
    }

    pendingGameActionRef.current = pending;
    setPendingGameAction(pending);
    setSocketError(null);
    try {
      currentSocket.send(JSON.stringify(roomSocketContract.clientMessage.parse(message)));
      return true;
    } catch {
      pendingGameActionRef.current = null;
      setPendingGameAction(null);
      setSocketError("対局操作を送信できませんでした。");
      return false;
    }
  }

  function sendGameMessage(
    message: Exclude<GameCommandFor<T["settings"]["game"]>, { type: "room.game.start" }>,
    pending: PendingActionFor<T["settings"]["game"]>,
  ): boolean {
    return sendGameOperation(message, { type: "game", action: pending });
  }

  function playOwnMove(lastMove: string): void {
    soundTrackerRef.current?.recordOwnMove(room, lastMove);
    roomSounds.play(["put"]);
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
    sendGameOperation({ type: "room.game.start" }, { type: "start" });
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

  function sendSettingsMessage(
    message: CommonSettingsCommand | GameSettingsCommandFor<T["settings"]["game"]>,
  ): void {
    const currentSocket = socketRef.current;
    if (
      !canManageSettings ||
      pendingSettingsRef.current ||
      currentSocket?.readyState !== WebSocket.OPEN
    )
      return;
    pendingSettingsRef.current = true;
    setPendingSettings(true);
    setPendingSettingsCommand(message);
    setSocketError(null);
    try {
      currentSocket.send(JSON.stringify(roomSocketContract.clientMessage.parse(message)));
    } catch {
      pendingSettingsRef.current = false;
      setPendingSettings(false);
      setPendingSettingsCommand(null);
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
    pendingSettingsCommand,
    newCpuLevel,
    setNewCpuLevel,
    pendingGameAction:
      pendingGameAction?.type === "game" ? pendingGameAction.action : pendingGameAction,
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
    playOwnMove,
    handleStartClick,
    handleReadyClick,
    changeMode,
    changeTimeControl: (timeControl: RoomTimeControl) =>
      sendSettingsMessage({ type: "room.time-control.set", timeControl }),
    sendGameSettingsMessage: (message: GameSettingsCommandFor<T["settings"]["game"]>) =>
      sendSettingsMessage(message),
    addCpu,
    changeCpuLevel,
    removeCpu,
    handleLeaveClick,
  };
}
