import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { useNavigate } from "react-router";
import { matchmakingQueues, type RatedMatchmakingGame } from "@tetraboard/protocol";
import { useQueueController } from "../../shared/QueueDocumentController";
import { canStoreRoomMembership, saveRoomMembershipToken } from "../../shared/roomMembership";
import { useAccount } from "../account/useAccount";
import { readMatchmaking, matchmakingOperation, type ObservedMatchmaking } from "./matchmakingApi";
import {
  readMatchmakingQueue,
  saveMatchmakingQueue,
  clearMatchmakingQueue,
  saveMatchmakingRoom,
} from "./matchmakingStorage";
import { matchmakingScope } from "./paths";
type ObservedState = ObservedMatchmaking & { receivedAtMs: number };
const idle: ObservedState = { status: "idle", serverNowMs: 0, receivedAtMs: 0 };
export function useMatchmaking(game: RatedMatchmakingGame) {
  const account = useAccount(),
    navigate = useNavigate();
  const { controller, controllerId } = useQueueController();
  const identity = account.user?.isGuest ? null : (account.user?.profileId ?? null);
  const legacyIdentity = game === "four-reversi" ? account.user?.profileId : undefined;
  const scope = matchmakingScope(identity ?? legacyIdentity ?? "visitor", game);
  const epoch = useMemo(() => Symbol(`${scope}:${controllerId}`), [scope, controllerId]);
  const [visible, setVisible] = useState<{
    epoch: symbol;
    data: ObservedState;
    error: string | null;
    pending: boolean;
    verified: boolean;
  }>({ epoch, data: idle, error: null, pending: false, verified: false });
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
    joinOperationId: null as string | null,
    verified: false,
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
      joinOperationId: null,
      verified: false,
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
    (data: ObservedMatchmaking, fromAction = false) => {
      if (!valid()) return;
      const ended = !fromAction && data.status === "idle" && active.current.data.status !== "idle";
      const observed = { ...data, receivedAtMs: performance.now() };
      active.current.verified = true;
      active.current.data = observed;
      setVisible((previous) => ({
        epoch,
        data: observed,
        error: ended
          ? "待機が終了しました。参加する場合は、もう一度対戦相手を探してください。"
          : !fromAction &&
              data.status === "idle" &&
              previous.epoch === epoch &&
              previous.error?.startsWith("待機が終了")
            ? previous.error
            : null,
        pending: false,
        verified: true,
      }));
      if (data.status === "idle") {
        active.current.joinOperationId = null;
        if (identity) clearMatchmakingQueue(identity, game);
        controller.forget(scope);
        return;
      }
      if (data.controllerId === controllerId && data.operationId && data.version) {
        if (!data.legacy && identity)
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
    [valid, scope, identity, controller, controllerId, game, epoch],
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
      const legacyLocal = legacyIdentity ? readMatchmakingQueue(legacyIdentity, game, true) : null;
      if (data.status === "idle" && legacyLocal) {
        const legacy = await readMatchmaking(game, controllerId, undefined, true);
        if (!valid() || sequence !== active.current.sequence) return;
        if (
          legacy.operationId === legacyLocal.operationId &&
          (legacy.status === "matched" || legacy.status === "playing")
        )
          data = legacy;
        else if (legacy.status === "idle" && legacyIdentity)
          clearMatchmakingQueue(legacyIdentity, game, true);
      }
      const local = data.legacy
        ? legacyLocal
        : identity
          ? readMatchmakingQueue(identity, game)
          : null;
      if (
        data.status !== "idle" &&
        !data.previousMatch &&
        data.controllerId !== controllerId &&
        local?.operationId === data.operationId &&
        controller.isReload() &&
        (await controller.acquire(scope))
      ) {
        if (!valid() || sequence !== active.current.sequence) return;
        data = await matchmakingOperation(
          game,
          "takeover",
          {
            operationId: data.operationId!,
            controllerId,
            version: data.version!,
          },
          undefined,
          data.legacy,
        );
        if (!valid() || sequence !== active.current.sequence) return;
        controller.announce(scope);
      }
      accept(data);
    } catch (error) {
      if (valid() && sequence === active.current.sequence) {
        active.current.verified = false;
        setVisible((previous) => ({
          epoch,
          data: previous.epoch === epoch ? previous.data : idle,
          pending: false,
          verified: false,
          error: error instanceof Error ? error.message : "待機情報を取得できません。",
        }));
      }
    } finally {
      if (valid()) active.current.reading = false;
    }
  }, [
    account.loading,
    account.error,
    valid,
    controllerId,
    identity,
    legacyIdentity,
    controller,
    scope,
    accept,
    game,
    epoch,
  ]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const perform = useCallback(
    async (action: "join" | "heartbeat" | "cancel" | "takeover", onJoinSent?: () => void) => {
      const current = active.current.data;
      const actor = current.legacy && action === "takeover" ? legacyIdentity : identity;
      if (!actor || !valid() || account.loading || account.error || active.current.busy) return;
      const data = current;
      const operationId =
        action === "join"
          ? (active.current.joinOperationId ?? crypto.randomUUID())
          : data.operationId;
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
      setVisible((previous) => ({ ...previous, epoch, pending: true, error: null }));
      try {
        if (action === "join") {
          if (!canStoreRoomMembership())
            throw Error("参加資格を保存できません。ブラウザの保存領域を確認してください。");
          saveMatchmakingQueue(actor, { operationId, controllerId, version: 1 }, game);
          active.current.joinOperationId = operationId;
        }
        if (action === "join" || action === "takeover") await controller.acquire(scope, true);
        if (!valid()) return;
        const request = matchmakingOperation(
          game,
          action,
          {
            operationId,
            controllerId,
            ...(action === "cancel" || action === "takeover" ? { version: data.version! } : {}),
          },
          undefined,
          data.legacy,
        );
        if (action === "join") onJoinSent?.();
        const result = await request;
        if (!valid()) return;
        accept(result, true);
        if (action === "join" || action === "takeover") controller.announce(scope);
      } catch (error) {
        if (valid())
          setVisible((previous) => ({
            ...previous,
            epoch,
            pending: false,
            error: error instanceof Error ? error.message : "マッチングを処理できません。",
          }));
      } finally {
        if (valid()) active.current.busy = false;
      }
    },
    [
      identity,
      legacyIdentity,
      valid,
      account.loading,
      account.error,
      controllerId,
      controller,
      scope,
      accept,
      game,
      epoch,
    ],
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (active.current.data.status === "waiting") void perform("heartbeat");
    }, matchmakingQueues[game].heartbeatMs);
    return () => window.clearInterval(timer);
  }, [perform, game]);
  const enter = useCallback(async () => {
    const data = active.current.data;
    const actor = data.legacy ? legacyIdentity : identity;
    if (!actor || !valid() || active.current.busy || active.current.moving) return;
    if (
      data.previousMatch ||
      !data.assignment ||
      data.controllerId !== controllerId ||
      controller.version(scope, data.operationId) !== data.version
    )
      return;
    active.current.busy = true;
    ++active.current.sequence;
    setVisible((previous) => ({ ...previous, pending: true, error: null }));
    try {
      const latest = await readMatchmaking(game, controllerId, undefined, data.legacy);
      if (valid() && latest.previousMatch) {
        accept(latest);
        return;
      }
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
          identity: actor,
          operationId: latest.operationId!,
          controllerId,
          version: latest.version!,
          roomId: a.roomId,
          instanceId: a.instanceId,
          ...(!latest.legacy ? { game } : {}),
        })
      )
        throw Error("ルームの参加資格を保存できません。");
      active.current.moving = true;
      void navigate(`/rooms/${a.roomId}?invite=${a.instanceId}`, { replace: true });
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
        if (!active.current.moving) setVisible((previous) => ({ ...previous, pending: false }));
      }
    }
  }, [identity, legacyIdentity, valid, controllerId, controller, scope, navigate, game, accept]);
  const data = visible.epoch === epoch ? visible.data : idle;
  const owned =
    data.controllerId === controllerId &&
    controller.version(scope, data.operationId) === data.version;
  const assignedMatchId = data.previousMatch ? undefined : data.assignment?.matchId;
  useEffect(() => {
    if (owned && assignedMatchId) void enter();
  }, [owned, assignedMatchId, data.status, enter]);
  const join = useCallback(
    (onSent?: () => void) => {
      if (
        !identity ||
        !valid() ||
        account.loading ||
        account.error ||
        active.current.busy ||
        !active.current.verified ||
        active.current.data.previousMatch ||
        active.current.data.status !== "idle" ||
        active.current.data.enabled !== true
      )
        return false;
      void perform("join", onSent);
      return true;
    },
    [identity, valid, account.loading, account.error, perform],
  );
  const cancel = useCallback(() => perform("cancel"), [perform]);
  const takeover = useCallback(() => perform("takeover"), [perform]);
  return {
    data,
    error: visible.epoch === epoch ? visible.error : null,
    pending: visible.epoch === epoch && visible.pending,
    verified: visible.epoch === epoch && visible.verified,
    owned,
    identity,
    refresh,
    join,
    cancel,
    takeover,
    enter,
  };
}
