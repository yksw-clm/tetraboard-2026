import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { TournamentParticipation } from "@tetraboard/protocol";
import { useAccount } from "../account/useAccount";
import { registrationReturnFromState, saveRegistrationReturn } from "../account/registrationReturn";
import { saveRoomMembershipToken } from "../../shared/roomMembership";
import {
  clearTournamentQueue,
  createTournamentQueue,
  readTournamentQueue,
  saveTournamentQueue,
  saveTournamentRoom,
} from "./tournamentQueueStorage";
import {
  claimTournamentController,
  readTournament,
  readTournamentParticipation,
  tournamentOperation,
} from "./tournamentApi";
import { useTournamentController } from "./tournamentController";

type Detail = Awaited<ReturnType<typeof readTournament>>;
const idle: TournamentParticipation = {
  entered: false,
  status: "idle",
  controller: "none",
  controllerVersion: 0,
};

export function useTournament(id: number) {
  const account = useAccount();
  const navigate = useNavigate();
  const location = useLocation();
  const { controller: documentController, controllerId } = useTournamentController();
  const identity = account.user?.profileCompleted
    ? (account.user.profileId ?? account.user.username)
    : null;
  const legacyIdentity = useRef(account.user?.username ?? undefined);
  useEffect(() => {
    legacyIdentity.current = account.user?.username ?? undefined;
  }, [account.user?.username]);
  const key = `${id}:${identity ?? "guest"}`;
  const [state, setState] = useState<{
    key: string;
    data: Detail | null;
    participation: TournamentParticipation;
    canEnterRoom: boolean;
    participationReady: boolean;
    error: string | null;
  }>({
    key,
    data: null,
    participation: idle,
    canEnterRoom: false,
    participationReady: false,
    error: null,
  });
  const [heartbeatWarning, setHeartbeatWarning] = useState<{
    key: string;
    operationId: string;
    value: string;
  } | null>(null);
  const [entryDialog, setEntryDialog] = useState<{ key: string; open: boolean }>({
    key,
    open: false,
  });
  const [pending, setPending] = useState<{ key: string; value: string | null }>({
    key,
    value: null,
  });
  const [message, setMessage] = useState<{ key: string; value: string | null }>({
    key,
    value: null,
  });
  const requests = useRef<AbortController | null>(null);
  const claimGeneration = useRef(0);
  const current = useRef({
    key,
    controllerId,
    disposed: false,
    participation: idle,
    movingToRoom: false,
  });
  const resumeAttempt = useRef<string | null>(null);
  const action = useRef<string | null>(null);
  const authUnavailable = useRef(false);
  useLayoutEffect(() => {
    authUnavailable.current = account.loading || Boolean(account.error);
  }, [account.loading, account.error]);
  const entryReturn = registrationReturnFromState(location.state, `/tournaments/${id}`);
  const resumedEntry = useRef<string | null>(null);
  const requestedEntry = location.state?.tournamentEntryRequested === true;
  const refresh = useCallback(async () => {
    const requestControllerId = documentController.getIdentity();
    const requestClaimGeneration = claimGeneration.current;
    requests.current?.abort();
    const controller = new AbortController();
    requests.current = controller;
    try {
      const [detailResult, participationResult] = await Promise.allSettled([
        readTournament(id, controller.signal).then((data) => {
          if (
            !controller.signal.aborted &&
            current.current.key === key &&
            !current.current.disposed &&
            documentController.getIdentity() === requestControllerId &&
            requestClaimGeneration === claimGeneration.current
          )
            setState((previous) => ({
              ...(previous.key === key
                ? previous
                : {
                    key,
                    participation: idle,
                    canEnterRoom: false,
                    participationReady: false,
                    error: null,
                  }),
              data,
            }));
          return data;
        }),
        identity
          ? readTournamentParticipation(id, controller.signal, requestControllerId)
          : Promise.resolve(idle),
      ]);
      if (controller.signal.aborted || current.current.key !== key || current.current.disposed)
        return;
      if (detailResult.status === "rejected") throw detailResult.reason;
      if (participationResult.status === "rejected") throw participationResult.reason;
      const data = detailResult.value;
      const participation = participationResult.value;
      if (
        documentController.getIdentity() !== requestControllerId ||
        requestClaimGeneration !== claimGeneration.current
      )
        return;
      current.current.participation = participation;
      setHeartbeatWarning(null);
      if (participation.controller === "other") documentController.forget(key);
      if (identity && participation.status === "idle" && action.current !== key) {
        clearTournamentQueue(id, identity, legacyIdentity.current);
        documentController.forget(key);
      }
      const credential = identity && readTournamentQueue(id, identity, legacyIdentity.current);
      const canEnterRoom = Boolean(
        credential &&
        credential.operationId === participation.operationId &&
        participation.roomId &&
        participation.instanceId &&
        participation.controller === "self" &&
        documentController.version(key, participation.operationId) ===
          participation.controllerVersion,
      );
      setState({ key, data, participation, canEnterRoom, participationReady: true, error: null });
    } catch (error) {
      if (!controller.signal.aborted && current.current.key === key && !current.current.disposed)
        setState((previous) => ({
          ...(previous.key === key
            ? previous
            : { data: null, participation: idle, canEnterRoom: false, participationReady: false }),
          key,
          participationReady: false,
          error: error instanceof Error ? error.message : "大会を取得できませんでした。",
        }));
    } finally {
      if (requests.current === controller) requests.current = null;
    }
  }, [id, identity, key, documentController]);
  const enterRoom = useCallback(async () => {
    const participation = current.current.participation;
    if (
      current.current.disposed ||
      current.current.key !== key ||
      current.current.movingToRoom ||
      account.loading ||
      account.error ||
      !identity ||
      !participation.roomId ||
      !participation.instanceId ||
      !["matched", "playing"].includes(participation.status)
    )
      return;
    const version = documentController.version(key, participation.operationId);
    if (
      !participation.operationId ||
      participation.controller !== "self" ||
      version !== participation.controllerVersion ||
      action.current === key
    )
      return;
    action.current = key;
    claimGeneration.current++;
    requests.current?.abort();
    requests.current = null;
    setPending({ key, value: "room" });
    try {
      const result = await claimTournamentController(id, {
        operationId: participation.operationId,
        controllerId,
        takeover: false,
        expectedControllerVersion: version,
      });
      if (
        current.current.disposed ||
        current.current.key !== key ||
        documentController.getIdentity() !== controllerId ||
        authUnavailable.current ||
        documentController.version(key, participation.operationId) !== version ||
        current.current.participation.controller !== "self"
      )
        return;
      const latest = result.participation;
      if (
        latest.controller !== "self" ||
        latest.controllerVersion !== version ||
        latest.operationId !== participation.operationId ||
        !latest.roomId ||
        !latest.instanceId ||
        !["matched", "playing"].includes(latest.status)
      ) {
        await refresh();
        return;
      }
      saveTournamentQueue(id, identity, {
        operationId: latest.operationId,
        token: result.token,
        controllerVersion: latest.controllerVersion,
      });
      if (
        !saveRoomMembershipToken(latest.roomId, result.token) ||
        !saveTournamentRoom({
          tournamentId: id,
          identity,
          operationId: latest.operationId,
          roomId: latest.roomId,
          instanceId: latest.instanceId,
          controllerVersion: latest.controllerVersion,
        })
      )
        throw new Error("ルームの参加資格を保存できません。ブラウザの保存領域を確認してください。");
      documentController.remember(key, latest.operationId, latest.controllerVersion);
      current.current.movingToRoom = true;
      void navigate(`/rooms/${latest.roomId}?invite=${latest.instanceId}`);
    } catch (error) {
      if (
        !current.current.disposed &&
        current.current.key === key &&
        documentController.getIdentity() === controllerId
      ) {
        setMessage({
          key,
          value:
            error instanceof Error
              ? error.message
              : "入室できませんでした。状態を再確認してください。",
        });
        await refresh();
      }
    } finally {
      if (action.current === key) action.current = null;
      if (!current.current.disposed && current.current.key === key)
        setPending({ key, value: null });
    }
  }, [
    id,
    identity,
    key,
    navigate,
    account.loading,
    account.error,
    documentController,
    controllerId,
    refresh,
  ]);
  useEffect(() => {
    current.current = {
      key,
      controllerId: documentController.getIdentity(),
      disposed: false,
      participation: idle,
      movingToRoom: false,
    };
    const timeout = window.setTimeout(() => void refresh(), 0);
    const visibleRefresh = () => {
      if (document.visibilityState === "visible" && action.current !== key) void refresh();
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !requests.current && action.current !== key)
        void refresh();
    }, 5000);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      current.current.disposed = true;
      requests.current?.abort();
      requests.current = null;
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, [key, refresh, documentController]);
  useEffect(() => {
    const interval = window.setInterval(() => {
      const participation = current.current.participation;
      const operationId = participation.operationId;
      const version = documentController.version(key, operationId);
      if (
        !current.current.disposed &&
        current.current.key === key &&
        documentController.getIdentity() === controllerId &&
        participation.status === "waiting" &&
        participation.controller === "self" &&
        operationId &&
        version === participation.controllerVersion
      ) {
        void tournamentOperation(id, "queue", "PATCH", {
          operationId,
          controllerId,
          controllerVersion: version,
        })
          .then(() => {
            if (current.current.key === key && documentController.getIdentity() === controllerId)
              setHeartbeatWarning((previous) =>
                previous?.operationId === operationId ? null : previous,
              );
          })
          .catch(() => {
            const latest = current.current.participation;
            if (
              !current.current.disposed &&
              current.current.key === key &&
              documentController.getIdentity() === controllerId &&
              latest.status === "waiting" &&
              latest.operationId === operationId &&
              latest.controller === "self"
            ) {
              setHeartbeatWarning({
                key,
                operationId,
                value: "待機を継続できませんでした。状態を再確認してください。",
              });
              void refresh();
            }
          });
      }
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [id, key, controllerId, documentController, refresh]);
  useEffect(() => {
    if (current.current.controllerId !== controllerId) {
      current.current.controllerId = controllerId;
      if (action.current !== key) void refresh();
    }
  }, [controllerId, key, refresh]);
  const takeOver = useCallback(
    async (automatic = false) => {
      const participation = current.current.participation;
      if (
        !identity ||
        !participation.operationId ||
        account.loading ||
        account.error ||
        action.current === key
      )
        return;
      if (
        automatic &&
        (!documentController.isReload() ||
          location.state?.tournamentReturn ||
          new URLSearchParams(location.search).has("return"))
      )
        return;
      const saved = readTournamentQueue(id, identity, legacyIdentity.current);
      if (
        automatic &&
        (saved?.operationId !== participation.operationId ||
          saved.controllerVersion !== participation.controllerVersion)
      )
        return;
      if (automatic && !(await documentController.acquire(key))) return;
      if (current.current.disposed || current.current.key !== key) return;
      action.current = key;
      claimGeneration.current++;
      requests.current?.abort();
      requests.current = null;
      setPending({ key, value: "controller" });
      const nextControllerId = automatic
        ? documentController.getIdentity()
        : documentController.rotate();
      try {
        const result = await claimTournamentController(id, {
          operationId: participation.operationId,
          controllerId: nextControllerId,
          takeover: true,
          expectedControllerVersion: participation.controllerVersion,
        });
        if (
          current.current.disposed ||
          current.current.key !== key ||
          documentController.getIdentity() !== nextControllerId
        )
          return;
        const latest = result.participation;
        if (latest.controller !== "self" || latest.operationId !== participation.operationId)
          return;
        saveTournamentQueue(id, identity, {
          operationId: latest.operationId,
          token: result.token,
          controllerVersion: latest.controllerVersion,
        });
        documentController.remember(key, latest.operationId, latest.controllerVersion);
        await documentController.acquire(key, !automatic);
        if (
          current.current.disposed ||
          current.current.key !== key ||
          documentController.getIdentity() !== nextControllerId
        )
          return;
        documentController.announce(key);
        current.current.participation = latest;
        setHeartbeatWarning(null);
        if (latest.roomId && latest.instanceId && ["matched", "playing"].includes(latest.status)) {
          if (
            !saveRoomMembershipToken(latest.roomId, result.token) ||
            !saveTournamentRoom({
              tournamentId: id,
              identity,
              operationId: latest.operationId,
              roomId: latest.roomId,
              instanceId: latest.instanceId,
              controllerVersion: latest.controllerVersion,
            })
          )
            throw new Error(
              "ルームの参加資格を保存できません。ブラウザの保存領域を確認してください。",
            );
          current.current.movingToRoom = true;
          void navigate(`/rooms/${latest.roomId}?invite=${latest.instanceId}`);
        } else await refresh();
      } catch (error) {
        if (
          !current.current.disposed &&
          current.current.key === key &&
          documentController.getIdentity() === nextControllerId
        ) {
          setMessage({
            key,
            value:
              error instanceof Error
                ? error.message
                : "引継ぎできませんでした。状態を再確認してください。",
          });
          await refresh();
        }
      } finally {
        if (action.current === key) action.current = null;
        if (!current.current.disposed && current.current.key === key)
          setPending({ key, value: null });
      }
    },
    [
      identity,
      account.loading,
      account.error,
      key,
      documentController,
      id,
      location.state,
      location.search,
      navigate,
      refresh,
    ],
  );
  useEffect(() => {
    const participation = state.key === key ? state.participation : idle;
    const credential = identity && readTournamentQueue(id, identity, legacyIdentity.current);
    const scope = `${key}:${participation.operationId}`;
    if (
      participation.controller !== "other" ||
      !credential ||
      credential.operationId !== participation.operationId ||
      resumeAttempt.current === scope
    )
      return;
    resumeAttempt.current = scope;
    void takeOver(true);
  }, [state, key, identity, id, takeOver]);
  const perform = useCallback(
    async (label: string, run: () => Promise<unknown>) => {
      if (action.current === key || account.loading || account.error) return;
      action.current = key;
      setPending({ key, value: label });
      setMessage({ key, value: null });
      try {
        await run();
        if (!current.current.disposed && current.current.key === key) await refresh();
      } catch (error) {
        if (!current.current.disposed && current.current.key === key) {
          setMessage({
            key,
            value: error instanceof Error ? error.message : "操作を完了できませんでした。",
          });
          await refresh();
        }
      } finally {
        if (action.current === key) action.current = null;
        if (!current.current.disposed && current.current.key === key)
          setPending({ key, value: null });
      }
    },
    [account.loading, account.error, key, refresh],
  );
  const enter = useCallback(() => {
    if (account.loading || account.error) return;
    if (!identity) {
      saveRegistrationReturn(
        { path: `/tournaments/${id}`, tournamentEntry: id },
        Boolean(account.user),
      );
      void navigate(account.user ? "/account/setup" : "/login");
      return;
    }
    setEntryDialog({ key, open: true });
  }, [account.loading, account.error, account.user, identity, id, key, navigate]);
  useEffect(() => {
    const returning = entryReturn?.oauthStarted && entryReturn.tournamentEntry === id && identity;
    if (
      (!returning && !requestedEntry) ||
      resumedEntry.current === key ||
      !state.data ||
      state.key !== key ||
      account.loading ||
      account.error ||
      !state.participationReady
    )
      return;
    const status = state.data.tournament.status;
    const timeout = window.setTimeout(() => {
      if (resumedEntry.current === key) return;
      resumedEntry.current = key;
      void navigate(location.pathname, { replace: true, state: null });
      if (["upcoming", "active"].includes(status)) enter();
      else setMessage({ key, value: "大会のエントリー受付は終了しました。" });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [
    entryReturn,
    requestedEntry,
    id,
    identity,
    state,
    key,
    enter,
    navigate,
    location.pathname,
    account.loading,
    account.error,
  ]);
  const visible =
    state.key === key
      ? state
      : {
          key,
          data: null,
          participation: idle,
          canEnterRoom: false,
          participationReady: false,
          error: null,
        };
  return {
    ...visible,
    participationLoading: Boolean(identity) && !visible.participationReady,
    canEnterRoom: visible.participationReady && visible.canEnterRoom,
    canControl:
      visible.participationReady &&
      visible.participation.controller === "self" &&
      documentController.version(key, visible.participation.operationId) ===
        visible.participation.controllerVersion,
    pending: pending.key === key ? pending.value : null,
    message:
      (message.key === key ? message.value : null) ??
      (heartbeatWarning?.key === key &&
      heartbeatWarning.operationId === visible.participation.operationId &&
      visible.participation.status === "waiting"
        ? heartbeatWarning.value
        : null),
    takeOver: () => void takeOver(),
    async returnToLobby() {
      if (action.current === key) return;
      const participation = current.current.participation;
      const version = documentController.version(key, participation.operationId);
      if (
        participation.status !== "playing" &&
        participation.controller === "self" &&
        participation.operationId &&
        version === participation.controllerVersion
      ) {
        action.current = key;
        setPending({ key, value: "cancel" });
        try {
          await tournamentOperation(id, "queue", "DELETE", {
            operationId: participation.operationId,
            controllerId,
            controllerVersion: version,
          });
          if (identity) clearTournamentQueue(id, identity, legacyIdentity.current);
          documentController.forget(key);
        } catch (error) {
          setMessage({
            key,
            value: error instanceof Error ? error.message : "待機を取り消せませんでした。",
          });
          await refresh();
          return;
        } finally {
          if (action.current === key) action.current = null;
          if (!current.current.disposed && current.current.key === key)
            setPending({ key, value: null });
        }
      }
      if (!current.current.disposed && current.current.key === key)
        void navigate("/games/four-shogi");
    },
    returnReason: (location.state?.tournamentReturn?.reason ??
      new URLSearchParams(location.search).get("return")) as string | undefined,
    refresh,
    enter,
    entryDialog: entryDialog.key === key && entryDialog.open,
    closeEntryDialog() {
      if (action.current !== key) setEntryDialog({ key, open: false });
    },
    confirmEntry() {
      if (!identity || visible.participation.entered) return;
      if (
        !visible.data ||
        !["upcoming", "active"].includes(visible.data.tournament.status) ||
        Date.now() >= visible.data.tournament.endsAtMs
      ) {
        setMessage({ key, value: "大会のエントリー受付は終了しました。" });
        return;
      }
      void perform("entry", async () => {
        await tournamentOperation(id, "entries", "POST", {});
        if (!current.current.disposed && current.current.key === key)
          setEntryDialog({ key, open: false });
      });
    },
    enterRoom,
    queue() {
      if (!identity) return;
      void perform("queue", async () => {
        const credential =
          readTournamentQueue(id, identity, legacyIdentity.current) ??
          createTournamentQueue(id, identity);
        await tournamentOperation(id, "queue", "POST", {
          operationId: credential.operationId,
          token: credential.token,
          controllerId,
        });
        if (
          !current.current.disposed &&
          current.current.key === key &&
          documentController.getIdentity() === controllerId
        ) {
          documentController.remember(key, credential.operationId, 1);
          saveTournamentQueue(id, identity, { ...credential, controllerVersion: 1 });
          await documentController.acquire(key, true);
          if (
            !current.current.disposed &&
            current.current.key === key &&
            documentController.getIdentity() === controllerId
          )
            documentController.announce(key);
        }
      });
    },
    cancel() {
      if (!identity) return;
      const operationId = visible.participation.operationId;
      const version = documentController.version(key, operationId);
      if (
        !operationId ||
        visible.participation.controller !== "self" ||
        version !== visible.participation.controllerVersion
      )
        return;
      void perform("cancel", async () => {
        await tournamentOperation(id, "queue", "DELETE", {
          operationId,
          controllerId,
          controllerVersion: version,
        });
        documentController.forget(key);
        clearTournamentQueue(id, identity, legacyIdentity.current);
      });
    },
  };
}
