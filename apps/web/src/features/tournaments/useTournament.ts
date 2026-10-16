import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { TournamentParticipation } from "@tetraboard/protocol";
import { useAccount } from "../account/useAccount";
import { registrationReturnFromState, saveRegistrationReturn } from "../account/registrationReturn";
import { saveRoomMembershipToken } from "../../shared/roomMembership";
import {
  clearTournamentQueue,
  createTournamentQueue,
  readTournamentQueue,
} from "./tournamentQueueStorage";
import { readTournament, readTournamentParticipation, tournamentOperation } from "./tournamentApi";

type Detail = Awaited<ReturnType<typeof readTournament>>;
const idle: TournamentParticipation = { entered: false, status: "idle" };

export function useTournament(id: number) {
  const account = useAccount();
  const navigate = useNavigate();
  const location = useLocation();
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
    error: string | null;
  }>({ key, data: null, participation: idle, canEnterRoom: false, error: null });
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
  const current = useRef({ key, disposed: false, participation: idle, movingToRoom: false });
  const action = useRef<string | null>(null);
  const entryReturn = registrationReturnFromState(location.state, `/tournaments/${id}`);
  const resumedEntry = useRef<string | null>(null);
  const requestedEntry = location.state?.tournamentEntryRequested === true;
  const refresh = useCallback(async () => {
    requests.current?.abort();
    const controller = new AbortController();
    requests.current = controller;
    try {
      const [data, participation] = await Promise.all([
        readTournament(id, controller.signal),
        identity ? readTournamentParticipation(id, controller.signal) : Promise.resolve(idle),
      ]);
      if (controller.signal.aborted || current.current.key !== key || current.current.disposed)
        return;
      current.current.participation = participation;
      if (identity && participation.status === "idle" && action.current !== key)
        clearTournamentQueue(id, identity, legacyIdentity.current);
      const credential = identity && readTournamentQueue(id, identity, legacyIdentity.current);
      const canEnterRoom = Boolean(
        credential &&
        credential.operationId === participation.operationId &&
        participation.roomId &&
        participation.instanceId,
      );
      setState({ key, data, participation, canEnterRoom, error: null });
    } catch (error) {
      if (!controller.signal.aborted && current.current.key === key && !current.current.disposed)
        setState((previous) => ({
          ...(previous.key === key
            ? previous
            : { data: null, participation: idle, canEnterRoom: false }),
          key,
          error: error instanceof Error ? error.message : "大会を取得できませんでした。",
        }));
    } finally {
      if (requests.current === controller) requests.current = null;
    }
  }, [id, identity, key]);
  const enterRoom = useCallback(() => {
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
    const credential = readTournamentQueue(id, identity, legacyIdentity.current);
    if (!credential || credential.operationId !== participation.operationId) return;
    if (!saveRoomMembershipToken(participation.roomId, credential.token)) {
      setMessage({
        key,
        value: "ルームの参加資格を保存できません。ブラウザの保存領域を確認してください。",
      });
      return;
    }
    current.current.movingToRoom = true;
    // 接続不成立で同じ待機へ戻る場合に備え、待機資格はルーム移動時に破棄しません。
    void navigate(`/rooms/${participation.roomId}?invite=${participation.instanceId}`);
  }, [id, identity, key, navigate, account.loading, account.error]);
  useEffect(() => {
    current.current = { key, disposed: false, participation: idle, movingToRoom: false };
    const timeout = window.setTimeout(() => void refresh(), 0);
    const visibleRefresh = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !requests.current) void refresh();
    }, 5000);
    document.addEventListener("visibilitychange", visibleRefresh);
    const cancel = () => {
      const credential = identity && readTournamentQueue(id, identity, legacyIdentity.current);
      if (
        credential &&
        !current.current.movingToRoom &&
        current.current.participation.status !== "playing"
      )
        void tournamentOperation(
          id,
          "queue",
          "DELETE",
          { operationId: credential.operationId },
          true,
        ).catch(() => {});
    };
    window.addEventListener("pagehide", cancel);
    return () => {
      current.current.disposed = true;
      requests.current?.abort();
      requests.current = null;
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibleRefresh);
      window.removeEventListener("pagehide", cancel);
      cancel();
    };
  }, [key, id, identity, refresh]);
  useEffect(() => {
    const interval = window.setInterval(() => {
      const credential = identity && readTournamentQueue(id, identity, legacyIdentity.current);
      if (
        credential &&
        current.current.key === key &&
        current.current.participation.status === "waiting"
      )
        void tournamentOperation(id, "queue", "PATCH", {
          operationId: credential.operationId,
        }).catch(() => {
          if (!current.current.disposed && current.current.key === key)
            setMessage({ key, value: "待機を継続できませんでした。状態を再確認してください。" });
        });
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [id, identity, key]);
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
      account.error
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
      : { key, data: null, participation: idle, canEnterRoom: false, error: null };
  return {
    ...visible,
    pending: pending.key === key ? pending.value : null,
    message: message.key === key ? message.value : null,
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
        await tournamentOperation(id, "queue", "POST", credential);
        if (current.current.disposed || current.current.key !== key)
          await tournamentOperation(
            id,
            "queue",
            "DELETE",
            { operationId: credential.operationId },
            true,
          );
      });
    },
    cancel() {
      if (!identity) return;
      const operationId = visible.participation.operationId;
      if (!operationId) return;
      void perform("cancel", async () => {
        await tournamentOperation(id, "queue", "DELETE", { operationId });
        clearTournamentQueue(id, identity, legacyIdentity.current);
      });
    },
  };
}
