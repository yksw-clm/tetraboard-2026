import { checkAccountPrivacy } from "../account/accountPrivacy";
import { gameCapacity } from "@tetraboard/protocol/games";
import { usePlayerProfiles } from "../players/usePlayerProfiles";
import { roomSnapshotFor } from "./roomSnapshot";
import { createUuid } from "../../shared/createUuid";
import type { GameSettingsCommandFor, PendingActionFor } from "./gameSessionTypes";
import {
  roomSocketContract,
  isFourShogiRoom,
  type FourShogiEliminatedHands,
  roomInteractionIntervalMs,
  type RoomStampId,
  type RoomStampNotification,
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
import { useCallback, useEffect, useRef, useState } from "react";
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
import { ClockWarningTracker, roomClockCount } from "./clockWarning";

const responseTimeoutMs = 10_000;
type ResponseWait = "fetch" | "connection" | "ready" | "settings" | "game" | "chat" | "stamp";

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
  settingsComplete: (
    room: T,
    command: CommonSettingsCommand | GameSettingsCommandFor<T["settings"]["game"]>,
    playerIds: ReadonlySet<string>,
  ) => boolean;
  onGameError?: (error: string) => boolean;
  gameOperationError: (error: string) => string | undefined;
  readSoundGame: (room: T) => SoundGameState;
  initialMembership: RoomMembership | null;
  initialServerNowMs: number;
  initialPresence: RoomPresence;
  initialFormationAnalysisSupported?: boolean;
  initialEliminatedHands?: FourShogiEliminatedHands | null;
  initialStampsSupported?: boolean;
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
    case "registration_pending":
      return "登録手続きが完了するか、席の保持期限が過ぎるまでお待ちください。";
    case "not_ready":
      return "参加者全員の準備完了が必要です。";
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
  settingsComplete,
  gameOperationError,
  onGameError,
  readSoundGame,
  initialFormationAnalysisSupported = false,
  initialEliminatedHands,
  initialStampsSupported = false,
}: RoomTransportOptions<T>) {
  useSoundEffects();
  const navigate = useNavigate();
  const [room, setRoom] = useState(initialRoom);
  const [eliminatedHands, setEliminatedHands] = useState(initialEliminatedHands ?? null);
  const profileStore = usePlayerProfiles()?.store;
  const previousStatus = useRef(initialRoom.status);
  useEffect(() => {
    if (previousStatus.current === "playing" && room.status === "waiting")
      profileStore?.invalidate({ game: room.settings.game });
    previousStatus.current = room.status;
  }, [room.status, room.settings.game, profileStore]);
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
  const [stampsSupported, setStampsSupported] = useState(initialStampsSupported);
  const [pendingStamp, setPendingStamp] = useState(false);
  const [stampError, setStampError] = useState<string | null>(null);
  const pendingStampRef = useRef<string | null>(null);
  const [interactionBlockedUntil, setInteractionBlockedUntil] = useState(0);
  const interactionBlockedUntilRef = useRef(0);
  const serverOffsetRef = useRef(0);
  const stampListeners = useRef(new Set<(notification: RoomStampNotification | null) => void>());
  const subscribeStamps = useCallback(
    (listener: (notification: RoomStampNotification | null) => void) => {
      stampListeners.current.add(listener);
      return () => {
        stampListeners.current.delete(listener);
      };
    },
    [],
  );
  const blockInteractionUntil = useCallback((serverAtMs: number) => {
    const localAtMs = serverAtMs - serverOffsetRef.current;
    if (localAtMs <= Date.now()) return;
    interactionBlockedUntilRef.current = Math.max(interactionBlockedUntilRef.current, localAtMs);
    setInteractionBlockedUntil(interactionBlockedUntilRef.current);
  }, []);
  useEffect(() => {
    if (interactionBlockedUntil === 0) return;
    const timer = setTimeout(
      () => {
        interactionBlockedUntilRef.current = 0;
        setInteractionBlockedUntil(0);
      },
      Math.max(0, interactionBlockedUntil - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [interactionBlockedUntil]);

  const [clockSync, setClockSync] = useState(() => ({
    serverNowMs: initialServerNowMs,
    receivedAt: performance.now(),
  }));
  const [serverNowMs, setServerNowMs] = useState(initialServerNowMs);
  const socketRef = useRef<WebSocket | null>(null);
  const responseWaitRef = useRef<{
    start: (key: ResponseWait) => void;
    clear: (key: ResponseWait) => void;
  } | null>(null);
  const trackChatRef = useRef<((text: string) => void) | null>(null);
  const soundTrackerRef = useRef<RoomSoundTracker<T> | null>(null);
  const clockSoundRef = useRef<{
    tick: () => void;
    consume: () => void;
    leave: (leaving: boolean) => void;
  } | null>(null);
  const pendingReadyRef = useRef<boolean | null>(null);
  const pendingSettingsRef = useRef(false);
  const settingsConfirmationRef = useRef<{
    command: CommonSettingsCommand | GameSettingsCommandFor<T["settings"]["game"]>;
    playerIds: Set<string>;
  } | null>(null);
  const pendingGameActionRef = useRef<PendingOperation<
    PendingActionFor<T["settings"]["game"]>
  > | null>(null);

  useEffect(() => {
    if (room.status !== "playing") return;
    const update = () => {
      setServerNowMs(clockSync.serverNowMs + performance.now() - clockSync.receivedAt);
      clockSoundRef.current?.tick();
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [room.status, clockSync]);

  useEffect(() => {
    serverOffsetRef.current = initialServerNowMs - Date.now();
    let active = true;
    let suspended = false;
    let generation = 0;
    let synchronizing = false;
    let receivedSnapshot = false;
    let authenticationConfirmed = initialMembership === null;
    const soundTracker = new RoomSoundTracker(readSoundGame);
    soundTrackerRef.current = soundTracker;
    const releaseSounds = roomSounds.retainRoom(initialRoom.instanceId);
    const clockWarnings = new ClockWarningTracker();
    let clockReady = false;
    let clockLeaving = false;
    let clockReceivedAt = performance.now();
    let soundingCount: string | null = null;
    let soundReady = true;
    let soundBaselineAtMs: number | null = null;
    let latestSnapshot: {
      room: T;
      presence: RoomPresence;
      serverNowMs: number;
    } | null = null;
    let socket: WebSocket | null = null;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const waits = new Map<
      ResponseWait,
      { timer: ReturnType<typeof setTimeout>; expiresAt: number }
    >();
    let pendingChat: { text: string; ids: Set<string> } | null = null;
    let retryDelay = 1000;
    let currentMembership = initialMembership;
    let formationAnalysisSupported = initialFormationAnalysisSupported;
    let handsSupported = initialEliminatedHands !== undefined;
    let socketHandsSupported = handsSupported;
    let stampSupported = initialStampsSupported;
    let socketStampSupported = initialStampsSupported;
    let stampBaselineAtMs: number | null = null;
    const stampIds = new Set<string>();
    const resetStamps = () => {
      for (const listener of stampListeners.current) listener(null);
    };

    function clockNow(): number {
      return (
        (latestSnapshot?.serverNowMs ?? initialServerNowMs) + performance.now() - clockReceivedAt
      );
    }

    function pauseClock(): void {
      clockReady = false;
      soundingCount = null;
      roomSounds.stopClock();
    }

    function checkClock(): void {
      const count = latestSnapshot === null ? null : roomClockCount(latestSnapshot.room);
      const at = clockNow();
      if (
        !clockReady ||
        !active ||
        suspended ||
        synchronizing ||
        clockLeaving ||
        !authenticationConfirmed ||
        document.visibilityState !== "visible" ||
        socket?.readyState !== WebSocket.OPEN
      ) {
        clockWarnings.baseline(count, at);
        roomSounds.stopClock();
        soundingCount = null;
        return;
      }
      if (count?.id !== soundingCount || count?.playerId !== currentMembership?.playerId) {
        roomSounds.stopClock();
        soundingCount = null;
      }
      const remaining = clockWarnings.observe(count, at, currentMembership?.playerId ?? null);
      if (remaining !== null) {
        soundingCount = count!.id;
        roomSounds.playClock(remaining);
      }
      if (count !== null && soundingCount === count.id)
        roomSounds.updateClockDeadline(count.expiresAt - at);
    }

    clockSoundRef.current = {
      tick: checkClock,
      consume: () => {
        clockWarnings.consume(latestSnapshot === null ? null : roomClockCount(latestSnapshot.room));
        soundingCount = null;
        roomSounds.stopClock();
      },
      leave: (leaving) => {
        clockLeaving = leaving;
        checkClock();
      },
    };
    const releaseClockAvailability = roomSounds.subscribeAvailability(() => {
      clockWarnings.baseline(
        latestSnapshot === null ? null : roomClockCount(latestSnapshot.room),
        clockNow(),
      );
    });
    const clearPendingStamp = () => {
      pendingStampRef.current = null;
      setPendingStamp(false);
      clearWait("stamp");
    };

    function clearWait(key: ResponseWait): void {
      const wait = waits.get(key);
      if (wait) clearTimeout(wait.timer);
      waits.delete(key);
    }

    function startWait(key: ResponseWait): void {
      clearWait(key);
      waits.set(key, {
        expiresAt: Date.now() + responseTimeoutMs,
        timer: setTimeout(() => {
          if (key === "stamp") setStampError("スタンプの応答がありません。接続を確認しています。");
          recover();
        }, responseTimeoutMs),
      });
    }
    responseWaitRef.current = { start: startWait, clear: clearWait };

    function clearPendingReady(): void {
      clearWait("ready");
      pendingReadyRef.current = null;
      setPendingReady(null);
    }

    function clearPendingSettings(): void {
      clearWait("settings");
      pendingSettingsRef.current = false;
      settingsConfirmationRef.current = null;
      setPendingSettings(false);
      setPendingSettingsCommand(null);
    }

    function clearPendingGameAction(): void {
      clearWait("game");
      soundTracker.clearOwnMove();
      pendingGameActionRef.current = null;
      setPendingGameAction(null);
    }

    function stopTransport(): void {
      generation++;
      synchronizing = false;
      controller?.abort();
      controller = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const key of waits.keys()) clearWait(key);
      pendingChat = null;
      clearPendingStamp();
      resetStamps();
      stampIds.clear();
      soundTracker.reset();
      soundReady = false;
      pauseClock();
      roomSounds.stop();
      setAuthenticated(false);
      clearPendingReady();
      clearPendingSettings();
      clearPendingGameAction();
      // close通知を待たずに無効化し、古い接続からの再試行を防ぎます。
      const previous = socket;
      socket = null;
      socketRef.current = null;
      previous?.close();
    }

    function stopUnavailable(message: string): void {
      active = false;
      stopTransport();
      setUnavailable(message);
    }

    function scheduleReconnect(): void {
      if (!active || suspended || timer !== null) return;
      setConnection("再接続中");
      timer = setTimeout(() => {
        timer = null;
        void refresh(false);
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    }

    function recover(): void {
      if (!active || suspended) return;
      stopTransport();
      scheduleReconnect();
    }

    function applySnapshot(
      latest: {
        room: T;
        presence: RoomPresence;
        serverNowMs: number;
        eliminatedHands?: FourShogiEliminatedHands | null;
      },
      fromFetch = false,
    ): void {
      if (
        latestSnapshot !== null &&
        (latest.serverNowMs < latestSnapshot.serverNowMs ||
          (fromFetch && latest.serverNowMs === latestSnapshot.serverNowMs))
      )
        return;
      if (latestSnapshot?.room.status === "waiting" && latest.room.status === "playing") {
        resetStamps();
        stampBaselineAtMs = latest.serverNowMs;
      }
      serverOffsetRef.current = latest.serverNowMs - Date.now();
      latestSnapshot = latest;
      clockReceivedAt = performance.now();
      if (
        currentMembership &&
        latest.room.players.some(
          (p) => p.id === currentMembership?.playerId && p.kind === "human" && p.retired,
        )
      ) {
        clearRoomMembershipToken(initialRoom.id);
        currentMembership = null;
        setMembership(null);
        checkAccountPrivacy();
      }
      setRoom(latest.room);
      setEliminatedHands(latest.eliminatedHands ?? null);
      setPresence(latest.presence);
      setClockSync({ serverNowMs: latest.serverNowMs, receivedAt: performance.now() });
      checkClock();
    }

    async function refresh(keepSocket: boolean): Promise<void> {
      if (!active || suspended || synchronizing) return;
      if (!keepSocket && socket !== null) stopTransport();
      synchronizing = true;
      pauseClock();
      clearWait("connection");
      authenticationConfirmed = false;
      setAuthenticated(false);
      setConnection("再接続中");
      soundReady = false;
      controller = new AbortController();
      const currentController = controller;
      const currentGeneration = ++generation;
      const isCurrent = () => active && !suspended && currentGeneration === generation;
      try {
        startWait("fetch");
        const latest = await fetchRoom(
          initialRoom.id,
          currentController.signal,
          initialRoom.instanceId,
        );
        if (!isCurrent()) return;
        startWait("fetch");
        const latestMembership = await fetchRoomMembership(
          initialRoom.id,
          currentController.signal,
        );
        if (!isCurrent()) return;
        clearWait("fetch");
        controller = null;
        if (!isRoom(latest.room)) {
          stopUnavailable(roomChangedMessage);
          return;
        }
        if (
          latestMembership !== null &&
          !latest.room.players.some((player) => player.id === latestMembership.playerId)
        )
          throw new Error("Membership does not match room");
        if (
          currentMembership &&
          latest.room.players.some(
            (p) => p.id === currentMembership?.playerId && p.kind === "human" && p.retired,
          )
        )
          checkAccountPrivacy();
        currentMembership = latestMembership;
        setMembership(latestMembership);
        applySnapshot({ ...latest, room: latest.room }, true);
        formationAnalysisSupported =
          latest.room.settings.game === "four-shogi" && latest.formationAnalysis !== undefined;
        handsSupported =
          latest.room.settings.game === "four-shogi" && latest.eliminatedHands !== undefined;
        stampSupported = latest.stampsSupported === true;
        setStampsSupported(stampSupported);
        if (
          keepSocket &&
          (socketStampSupported !== stampSupported || socketHandsSupported !== handsSupported)
        ) {
          stopTransport();
          synchronizing = false;
          connect();
          return;
        }
        stampBaselineAtMs = latestSnapshot!.serverNowMs;
        if (keepSocket && socket?.readyState === WebSocket.OPEN) {
          // 復帰中に受信した新しい局面を基準にし、溜まった通知を再演しません。
          soundTracker.baseline(latestSnapshot!.room);
          soundBaselineAtMs = latestSnapshot!.serverNowMs;
          soundReady = true;
          synchronizing = false;
          if (currentMembership === null) {
            authenticationConfirmed = true;
            clearWait("connection");
            setConnection("接続済み");
          } else {
            authenticationConfirmed = false;
            startWait("connection");
            socket.send(
              JSON.stringify(
                roomSocketContract.clientMessage.parse({
                  type: "room.auth",
                  token: readRoomMembershipToken(initialRoom.id),
                }),
              ),
            );
          }
        } else {
          synchronizing = false;
          connect();
        }
      } catch (error) {
        if (!isCurrent()) return;
        if (error instanceof Response && (error.status === 404 || error.status === 410)) {
          stopUnavailable(error.status === 410 ? roomChangedMessage : roomClosedMessage);
          return;
        }
        recover();
      }
    }

    const pageHidden = () => {
      if (!active || suspended) return;
      suspended = true;
      stopTransport();
      setConnection("再接続中");
    };
    const pageShown = () => {
      if (!active || !suspended) return;
      suspended = false;
      void refresh(false);
    };
    const visibilityChanged = () => {
      if (!active || suspended) return;
      soundTracker.reset();
      soundReady = false;
      resetStamps();
      pauseClock();
      if (document.visibilityState !== "visible") return;
      if ([...waits.values()].some((wait) => wait.expiresAt <= Date.now())) {
        recover();
      } else if (timer === null) {
        void refresh(socketRef.current?.readyState === WebSocket.OPEN);
      }
    };
    window.addEventListener("pagehide", pageHidden);
    window.addEventListener("pageshow", pageShown);
    document.addEventListener("visibilitychange", visibilityChanged);

    function connect(): void {
      pauseClock();
      soundTracker.reset();
      soundReady = true;
      soundBaselineAtMs = null;
      stampBaselineAtMs = null;
      socketStampSupported = stampSupported;
      socketHandsSupported = handsSupported;
      setAuthenticated(false);
      setSocketError(null);
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${scheme}//${window.location.host}/api${roomSocketContract.pathFor(initialRoom.id)}?instanceId=${initialRoom.instanceId}${formationAnalysisSupported ? "&formationAnalysis=1" : ""}${handsSupported ? "&eliminatedHands=1" : ""}${stampSupported ? "&stamps=1" : ""}`;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }

      startWait("connection");
      const currentSocket = socket;
      receivedSnapshot = false;
      authenticationConfirmed = currentMembership === null;
      function finishConnection(): void {
        if (!receivedSnapshot || !authenticationConfirmed || synchronizing) return;
        clearWait("connection");
        setConnection("接続済み");
        setAuthenticated(currentMembership !== null);
        if (!clockReady) {
          clockWarnings.baseline(
            latestSnapshot === null ? null : roomClockCount(latestSnapshot.room),
            clockNow(),
          );
          clockReady = true;
        }
        checkClock();
        retryDelay = 1000;
      }
      let chatIds: Set<string> | null = null;
      socketRef.current = currentSocket;
      currentSocket.onopen = () => {
        if (!active || suspended || currentSocket !== socketRef.current) return;
        startWait("connection");
        if (currentMembership === null) {
          finishConnection();
          return;
        }
        const token = readRoomMembershipToken(initialRoom.id);
        if (token === null) {
          currentMembership = null;
          setMembership(null);
          authenticationConfirmed = true;
          finishConnection();
          return;
        }
        try {
          currentSocket.send(
            JSON.stringify(roomSocketContract.clientMessage.parse({ type: "room.auth", token })),
          );
        } catch {
          recover();
        }
      };
      currentSocket.onmessage = (event: MessageEvent) => {
        if (!active || suspended || currentSocket !== socketRef.current) return;
        let body: unknown;
        try {
          body = JSON.parse(event.data as string);
        } catch {
          recover();
          return;
        }
        const message = roomSocketContract.message.safeParse(body);
        if (!message.success) {
          recover();
          return;
        }

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
          if (latestSnapshot !== null && message.data.serverNowMs < latestSnapshot.serverNowMs)
            return;
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
          applySnapshot({
            room: snapshot,
            presence: message.data.presence,
            serverNowMs: message.data.serverNowMs,
            eliminatedHands: message.data.eliminatedHands,
          });
          const confirmation = settingsConfirmationRef.current;
          if (
            confirmation !== null &&
            settingsComplete(snapshot, confirmation.command, confirmation.playerIds)
          )
            clearPendingSettings();
          receivedSnapshot = true;
          finishConnection();
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

        if (message.data.type === "room.stamp.received") {
          const notification = message.data;
          if (
            !socketStampSupported ||
            notification.instanceId !== initialRoom.instanceId ||
            stampIds.has(notification.id)
          )
            return;
          stampIds.add(notification.id);
          if (notification.senderId === currentMembership?.playerId) {
            blockInteractionUntil(notification.sentAtMs + roomInteractionIntervalMs);
            if (notification.requestId === pendingStampRef.current) clearPendingStamp();
          }
          if (
            receivedSnapshot &&
            authenticationConfirmed &&
            !synchronizing &&
            document.visibilityState === "visible" &&
            (stampBaselineAtMs === null || notification.sentAtMs > stampBaselineAtMs)
          ) {
            for (const listener of stampListeners.current) listener(notification);
          }
          return;
        }
        if (message.data.type === "room.stamp.error") {
          if (message.data.requestId !== pendingStampRef.current) return;
          clearPendingStamp();
          if (message.data.interactionAvailableAtMs !== undefined)
            blockInteractionUntil(message.data.interactionAvailableAtMs);
          setStampError(
            message.data.error === "rate_limited"
              ? "3秒おいてから送信してください。"
              : message.data.error === "muted"
                ? "このルームでは送信を停止されています。"
                : "スタンプを送信できませんでした。",
          );
          return;
        }

        if (message.data.type === "room.chat.snapshot") {
          const incoming = message.data.messages;
          if (stampSupported && currentMembership) {
            for (const entry of incoming) {
              if (entry.kind === "player" && entry.senderId === currentMembership.playerId)
                blockInteractionUntil(entry.sentAtMs + roomInteractionIntervalMs);
            }
          }
          if (
            pendingChat !== null &&
            incoming.some(
              (entry) =>
                entry.kind === "player" &&
                entry.senderId === currentMembership?.playerId &&
                entry.text === pendingChat!.text &&
                !pendingChat!.ids.has(entry.id),
            )
          ) {
            pendingChat = null;
            clearWait("chat");
          }
          if (chatIds !== null && !synchronizing && document.visibilityState === "visible") {
            const added = incoming.filter((entry) => !chatIds!.has(entry.id));
            if (added.length > 0)
              setChatNotifications((previous) => [...previous, ...added].slice(-100));
          }
          chatIds = new Set(incoming.map((entry) => entry.id));
          setChatMessages(message.data.messages);
          return;
        }
        if (message.data.type === "room.chat.error") {
          pendingChat = null;
          clearWait("chat");
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
            authenticationConfirmed = false;
            pauseClock();
            startWait("connection");
            return;
          }
          if (socketStampSupported && message.data.interactionAvailableAtMs !== undefined)
            blockInteractionUntil(message.data.interactionAvailableAtMs);
          currentMembership = message.data.membership;
          setMembership(message.data.membership);
          authenticationConfirmed = true;
          finishConnection();
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
          authenticationConfirmed = false;
          clearWait("connection");
          void refresh(true);
        } else {
          setSocketError(
            onGameError?.(message.data.error)
              ? null
              : operationErrorMessage(message.data.error, gameOperationError),
          );
        }
      };
      currentSocket.onerror = () => {
        if (active && !suspended && currentSocket === socketRef.current) recover();
      };
      currentSocket.onclose = (event) => {
        if (active && !suspended && currentSocket === socketRef.current) {
          if (event?.reason === "Account deleted") {
            clearRoomMembershipToken(initialRoom.id);
            currentMembership = null;
            setMembership(null);
            checkAccountPrivacy();
          }
          recover();
        }
      };
      trackChatRef.current = (text) => {
        pendingChat = { text, ids: new Set(chatIds ?? []) };
        startWait("chat");
      };
    }

    connect();
    return () => {
      active = false;
      window.removeEventListener("pagehide", pageHidden);
      window.removeEventListener("pageshow", pageShown);
      document.removeEventListener("visibilitychange", visibilityChanged);
      responseWaitRef.current = null;
      trackChatRef.current = null;
      soundTrackerRef.current = null;
      clockSoundRef.current = null;
      releaseClockAvailability();
      stopTransport();
      releaseSounds();
    };
  }, [
    initialFormationAnalysisSupported,
    initialEliminatedHands,
    initialStampsSupported,
    initialServerNowMs,
    blockInteractionUntil,
    initialRoom.id,
    initialRoom.instanceId,
    initialRoom.settings.game,
    initialMembership,
    isRoom,
    actionComplete,
    settingsComplete,
    gameOperationError,
    onGameError,
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
      if (message.type === "room.game.resign" || message.type === "room.game.action")
        clockSoundRef.current?.consume();
      responseWaitRef.current?.start("game");
      return true;
    } catch {
      pendingGameActionRef.current = null;
      setPendingGameAction(null);
      responseWaitRef.current?.clear("game");
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
      room.players.length !== gameCapacity(room.settings.game) ||
      room.players.some(
        (player) =>
          !player.ready ||
          !presence.connectedPlayerIds.includes(player.id) ||
          (player.kind === "human" && player.registrationPendingUntilMs !== undefined),
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
      (self.kind === "human" && self.registrationPendingUntilMs !== undefined) ||
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
      responseWaitRef.current?.start("ready");
    } catch {
      pendingReadyRef.current = null;
      setPendingReady(null);
      responseWaitRef.current?.clear("ready");
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
    settingsConfirmationRef.current = {
      command: message,
      playerIds: new Set(room.players.map((p) => p.id)),
    };
    setPendingSettings(true);
    setPendingSettingsCommand(message);
    setSocketError(null);
    try {
      currentSocket.send(JSON.stringify(roomSocketContract.clientMessage.parse(message)));
      responseWaitRef.current?.start("settings");
    } catch {
      pendingSettingsRef.current = false;
      settingsConfirmationRef.current = null;
      setPendingSettings(false);
      setPendingSettingsCommand(null);
      responseWaitRef.current?.clear("settings");
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
    clockSoundRef.current?.leave(true);
    setSocketError(null);
    try {
      await leaveRoom(room.id, token);
      clearRoomMembershipToken(room.id);
      void navigate(gameCatalog[room.settings.game].lobbyPath);
    } catch {
      setSocketError("退室できませんでした。再度お試しください。");
      setLeaving(false);
      clockSoundRef.current?.leave(false);
    }
  }

  function sendStamp(stampId: RoomStampId): boolean {
    const currentSocket = socketRef.current;
    if (
      !stampsSupported ||
      !authenticated ||
      connection !== "接続済み" ||
      leaving ||
      !self ||
      currentSocket?.readyState !== WebSocket.OPEN ||
      pendingStampRef.current !== null ||
      interactionBlockedUntilRef.current > Date.now() ||
      document.visibilityState !== "visible"
    )
      return false;
    const requestId = createUuid();
    pendingStampRef.current = requestId;
    setPendingStamp(true);
    setStampError(null);
    try {
      currentSocket.send(
        JSON.stringify(
          roomSocketContract.clientMessage.parse({
            type: "room.stamp.send",
            instanceId: room.instanceId,
            requestId,
            stampId,
          }),
        ),
      );
      responseWaitRef.current?.start("stamp");
      return true;
    } catch {
      pendingStampRef.current = null;
      setPendingStamp(false);
      responseWaitRef.current?.clear("stamp");
      setStampError("スタンプを送信できませんでした。接続を確認してください。");
      return false;
    }
  }

  function sendChat(text: string): boolean {
    if (
      !authenticated ||
      socketRef.current?.readyState !== WebSocket.OPEN ||
      leaving ||
      (stampsSupported &&
        (pendingStampRef.current !== null || interactionBlockedUntilRef.current > Date.now()))
    )
      return false;
    try {
      socketRef.current.send(
        JSON.stringify(roomSocketContract.clientMessage.parse({ type: "room.chat.send", text })),
      );
      trackChatRef.current?.(text);
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

  const displayedRoundId = isFourShogiRoom(room)
    ? room.status === "playing"
      ? room.roundId
      : room.lastRound?.roundId
    : null;
  return {
    room,
    eliminatedHands: eliminatedHands?.roundId === displayedRoundId ? eliminatedHands : null,
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
    stampsSupported,
    pendingStamp,
    stampError,
    subscribeStamps,
    sendStamp,
    interactionReady: !stampsSupported || interactionBlockedUntil === 0,
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
