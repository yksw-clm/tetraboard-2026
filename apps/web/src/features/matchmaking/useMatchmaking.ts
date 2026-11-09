import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { useNavigate } from "react-router";
import {
  matchmakingQueues,
  type MatchmakingGame,
  type MatchmakingState,
} from "@tetraboard/protocol";
import { useQueueController } from "../../shared/QueueDocumentController";
import { canStoreRoomMembership, saveRoomMembershipToken } from "../../shared/roomMembership";
import { useAccount } from "../account/useAccount";
import { readMatchmaking, matchmakingOperation } from "./matchmakingApi";
import {
  readMatchmakingQueue,
  saveMatchmakingQueue,
  clearMatchmakingQueue,
  saveMatchmakingRoom,
} from "./matchmakingStorage";
import { matchmakingScope } from "./paths";
type ObservedState = MatchmakingState & { receivedAtMs: number };
const idle: ObservedState = { status: "idle", serverNowMs: 0, receivedAtMs: 0 };
export function useMatchmaking(game: MatchmakingGame) {
  const account = useAccount(),
    navigate = useNavigate();
  const { controller, controllerId } = useQueueController();
  const identity =
    game === "shogi" && account.user?.isGuest ? null : (account.user?.profileId ?? null);
  const scope = matchmakingScope(identity ?? "visitor", game);
  const epoch = useMemo(() => Symbol(`${scope}:${controllerId}`), [scope, controllerId]);
  const [visible, setVisible] = useState<{
    scope: string;
    data: ObservedState;
    error: string | null;
    pending: boolean;
  }>({ scope, data: idle, error: null, pending: false });
  const active = useRef({
    scope,
    controllerId,
    epoch,
    disposed: false,
    moving: false,
    busy: false,
    heartbeat: false,
    reading: false,
    sequence: 0,
    data: idle,
  });
  useLayoutEffect(() => {
    active.current = {
      scope,
      controllerId,
      epoch,
      disposed: false,
      moving: false,
      busy: false,
      heartbeat: false,
      reading: false,
      sequence: 0,
      data: idle,
    };
    return () => {
      active.current.disposed = true;
      if (!active.current.moving) controller.release(scope);
    };
  }, [scope, controllerId, controller, epoch]);
  const valid = useCallback(
    () =>
      !active.current.disposed &&
      active.current.scope === scope &&
      active.current.epoch === epoch &&
      controller.getIdentity() === controllerId,
    [scope, controllerId, controller, epoch],
  );
  const accept = useCallback(
    (data: MatchmakingState, fromAction = false) => {
      if (!valid()) return;
      const ended =
        !fromAction &&
        data.status === "idle" &&
        (active.current.data.status !== "idle" ||
          (identity && readMatchmakingQueue(identity, game)));
      const observed = { ...data, receivedAtMs: performance.now() };
      active.current.data = observed;
      setVisible((previous) => ({
        scope,
        data: observed,
        error: ended
          ? "待機が終了しました。参加する場合は、もう一度対戦相手を探してください。"
          : !fromAction && data.status === "idle" && previous.error?.startsWith("待機が終了")
            ? previous.error
            : null,
        pending: false,
      }));
      if (!identity) return;
      if (data.status === "idle") {
        clearMatchmakingQueue(identity, game);
        controller.forget(scope);
        return;
      }
      if (data.controllerId === controllerId && data.operationId && data.version) {
        saveMatchmakingQueue(
          identity,
          {
            operationId: data.operationId,
            controllerId,
            version: data.version,
          },
          game,
        );
        controller.remember(scope, data.operationId, data.version);
      }
    },
    [valid, scope, identity, controller, controllerId, game],
  );
  const refresh = useCallback(async () => {
    if (
      account.loading ||
      account.error ||
      active.current.busy ||
      active.current.reading ||
      !valid()
    )
      return;
    active.current.reading = true;
    const sequence = ++active.current.sequence;
    try {
      let data = await readMatchmaking(game, controllerId);
      if (!valid() || sequence !== active.current.sequence) return;
      const local = identity ? readMatchmakingQueue(identity, game) : null;
      if (
        data.status !== "idle" &&
        data.controllerId !== controllerId &&
        local?.operationId === data.operationId &&
        controller.isReload() &&
        (await controller.acquire(scope))
      ) {
        if (!valid() || sequence !== active.current.sequence) return;
        data = await matchmakingOperation(game, "takeover", {
          operationId: data.operationId!,
          controllerId,
          version: data.version!,
        });
        if (!valid() || sequence !== active.current.sequence) return;
        controller.announce(scope);
      }
      accept(data);
    } catch (error) {
      if (valid() && sequence === active.current.sequence)
        setVisible((previous) => ({
          scope,
          data: previous.scope === scope ? previous.data : idle,
          pending: false,
          error: error instanceof Error ? error.message : "待機情報を取得できません。",
        }));
    } finally {
      if (valid()) active.current.reading = false;
    }
  }, [
    account.loading,
    account.error,
    valid,
    controllerId,
    identity,
    controller,
    scope,
    accept,
    game,
  ]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const perform = useCallback(
    async (action: "join" | "heartbeat" | "cancel" | "takeover") => {
      if (!identity || !valid() || account.loading || account.error || active.current.busy) return;
      const data = active.current.data,
        local = readMatchmakingQueue(identity, game);
      const operationId =
        action === "join" ? (local?.operationId ?? crypto.randomUUID()) : data.operationId;
      if (!operationId) return;
      if (
        (action === "heartbeat" || action === "cancel") &&
        (data.controllerId !== controllerId ||
          controller.version(scope, operationId) !== data.version)
      )
        return;
      if (action === "heartbeat") {
        if (active.current.heartbeat) return;
        active.current.heartbeat = true;
        const sequence = active.current.sequence;
        try {
          const result = await matchmakingOperation(game, "heartbeat", {
            operationId,
            controllerId,
            version: data.version!,
          });
          if (
            valid() &&
            active.current.sequence === sequence &&
            active.current.data.status === "waiting"
          )
            accept(result);
        } catch (error) {
          if (
            valid() &&
            active.current.sequence === sequence &&
            active.current.data.status === "waiting"
          )
            setVisible((previous) => ({
              ...previous,
              error: error instanceof Error ? error.message : "待機の継続を確認できません。",
            }));
        } finally {
          if (valid()) active.current.heartbeat = false;
        }
        return;
      }
      active.current.busy = true;
      ++active.current.sequence;
      setVisible((previous) => ({ ...previous, scope, pending: true, error: null }));
      try {
        if (action === "join") {
          if (!canStoreRoomMembership())
            throw Error("参加資格を保存できません。ブラウザの保存領域を確認してください。");
          saveMatchmakingQueue(identity, { operationId, controllerId, version: 1 }, game);
        }
        if (action === "join" || action === "takeover") await controller.acquire(scope, true);
        if (!valid()) return;
        const result = await matchmakingOperation(game, action, {
          operationId,
          controllerId,
          ...(action === "cancel" || action === "takeover" ? { version: data.version! } : {}),
        });
        if (!valid()) return;
        accept(result, true);
        if (action === "join" || action === "takeover") controller.announce(scope);
      } catch (error) {
        if (valid())
          setVisible((previous) => ({
            ...previous,
            scope,
            pending: false,
            error: error instanceof Error ? error.message : "マッチングを処理できません。",
          }));
      } finally {
        if (valid()) active.current.busy = false;
      }
    },
    [
      identity,
      valid,
      account.loading,
      account.error,
      controllerId,
      controller,
      scope,
      accept,
      game,
    ],
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (active.current.data.status === "waiting") void perform("heartbeat");
    }, matchmakingQueues[game].heartbeatMs);
    return () => window.clearInterval(timer);
  }, [perform, game]);
  const enter = useCallback(async () => {
    if (!identity || !valid() || active.current.busy || active.current.moving) return;
    const data = active.current.data;
    if (
      !data.assignment ||
      data.controllerId !== controllerId ||
      controller.version(scope, data.operationId) !== data.version
    )
      return;
    active.current.busy = true;
    ++active.current.sequence;
    if (game === "shogi") setVisible((previous) => ({ ...previous, pending: true, error: null }));
    try {
      const latest = await readMatchmaking(game, controllerId);
      if (
        !valid() ||
        !latest.assignment ||
        latest.operationId !== data.operationId ||
        latest.controllerId !== controllerId ||
        latest.version !== data.version
      )
        return;
      const a = latest.assignment;
      if (
        !saveRoomMembershipToken(a.roomId, a.membership.token) ||
        !saveMatchmakingRoom({
          identity,
          operationId: latest.operationId!,
          controllerId,
          version: latest.version!,
          roomId: a.roomId,
          instanceId: a.instanceId,
          ...(game === "shogi" ? { game } : {}),
        })
      )
        throw Error("ルームの参加資格を保存できません。");
      active.current.moving = true;
      void navigate(`/rooms/${a.roomId}?invite=${a.instanceId}`, { replace: game === "shogi" });
    } catch (error) {
      if (valid())
        setVisible((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "入室できません。",
          pending: false,
        }));
    } finally {
      if (valid()) {
        active.current.busy = false;
        if (game === "shogi" && !active.current.moving)
          setVisible((previous) => ({ ...previous, pending: false }));
      }
    }
  }, [identity, valid, controllerId, controller, scope, navigate, game]);
  const data = visible.scope === scope ? visible.data : idle;
  const owned =
    data.controllerId === controllerId &&
    controller.version(scope, data.operationId) === data.version;
  const assignedMatchId = data.assignment?.matchId;
  useEffect(() => {
    if (!owned || !assignedMatchId) return;
    if (game === "shogi") {
      void enter();
      return;
    }
    const timer = window.setTimeout(
      () => {
        void enter();
      },
      data.status === "playing" ? 0 : 5000,
    );
    return () => window.clearTimeout(timer);
  }, [owned, assignedMatchId, data.status, enter, game]);
  const join = useCallback(() => perform("join"), [perform]);
  const cancel = useCallback(() => perform("cancel"), [perform]);
  const takeover = useCallback(() => perform("takeover"), [perform]);
  return {
    data,
    error: visible.scope === scope ? visible.error : null,
    pending: visible.scope === scope && visible.pending,
    owned,
    identity,
    refresh,
    join,
    cancel,
    takeover,
    enter,
  };
}
