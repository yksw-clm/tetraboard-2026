import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker, useLocation, useNavigate } from "react-router";
import { shogiPlacementGames } from "@tetraboard/protocol";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppDialog } from "../../shared/ui/AppDialog";
import { useAccount } from "../account/useAccount";
import { LegalNotice } from "../privacy/LegalNotice";
import { readShogiRatingSummary } from "./matchmakingApi";
import { useMatchmaking } from "./useMatchmaking";

function ShogiRatingSummary() {
  const [result, setResult] = useState<
    Awaited<ReturnType<typeof readShogiRatingSummary>> | "error" | null
  >(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void readShogiRatingSummary(controller.signal).then(
      (summary) => {
        if (!controller.signal.aborted) setResult(summary);
      },
      () => {
        if (!controller.signal.aborted) setResult("error");
      },
    );
    return () => controller.abort();
  }, [attempt]);

  if (result === null) return <p role="status">レートを読み込んでいます…</p>;
  if (result === "error")
    return (
      <div className="flex flex-col items-center gap-2">
        <p role="alert">レートを取得できませんでした。</p>
        <AppButton
          appearance="secondary"
          size="compact"
          onPress={() => {
            setResult(null);
            setAttempt((current) => current + 1);
          }}
        >
          レートを再取得する
        </AppButton>
      </div>
    );
  return (
    <div className="text-center">
      <p className="text-sm text-muted">現在のレート</p>
      <p className="mt-1 text-4xl font-bold tabular-nums">
        {result.status === "rated" ? Math.round(result.rating) : "認定中"}
      </p>
      {result.status === "placement" && (
        <p className="mt-1 text-sm tabular-nums">
          {result.games} / {shogiPlacementGames}局
        </p>
      )}
    </div>
  );
}

export function ShogiMatchmakingDialog() {
  const account = useAccount();
  const matching = useMatchmaking("shogi");
  const location = useLocation();
  const navigate = useNavigate();
  const { cancel, data, enter, identity, join, owned, pending, refresh, takeover } = matching;
  const [confirm, setConfirm] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const rejoin = useRef(location.state?.matchmakingRejoin === true);
  const searching = (owned && data.status === "waiting") || (pending && data.status === "idle");
  const assigned = data.status === "matched" || data.status === "playing";
  const entering = assigned && owned && pending;
  if (confirm && !searching) setConfirm(false);
  const blocker = useBlocker(
    ({ historyAction, nextLocation }) =>
      (searching || entering) &&
      historyAction === "POP" &&
      (nextLocation.pathname !== location.pathname ||
        new URLSearchParams(nextLocation.search).get("matchmaking") !== "1"),
  );
  const close = useCallback(() => {
    if (blocker.state === "proceeding") return;
    if (blocker.state === "blocked") {
      blocker.proceed();
      return;
    }
    if (location.state?.shogiMatchmakingFromLobby === true) {
      void navigate(-1);
      return;
    }
    const search = new URLSearchParams(location.search);
    search.delete("matchmaking");
    void navigate(
      { pathname: location.pathname, search: search.toString(), hash: location.hash },
      { replace: true, state: null },
    );
  }, [blocker, location.pathname, location.search, location.hash, location.state, navigate]);

  useEffect(() => {
    if (cancelRequested && data.status === "idle" && !pending) close();
  }, [cancelRequested, data.status, pending, close]);

  useEffect(() => {
    if (blocker.state === "blocked" && !searching && !cancelRequested) blocker.reset();
  }, [blocker, searching, cancelRequested]);

  const ready = Boolean(
    identity &&
    account.user?.profileCompleted &&
    !account.loading &&
    !account.error &&
    data.enabled,
  );
  useEffect(() => {
    if (!rejoin.current || !ready || data.status !== "idle" || pending) return;
    rejoin.current = false;
    void navigate(location.pathname + location.search + location.hash, {
      replace: true,
      state: null,
    });
    void join();
  }, [
    ready,
    data.status,
    pending,
    join,
    navigate,
    location.pathname,
    location.search,
    location.hash,
  ]);

  const showConfirm = searching && (confirm || blocker.state === "blocked");
  function requestClose() {
    if (searching) setConfirm(true);
    else close();
  }
  function continueSearch() {
    setConfirm(false);
    setCancelRequested(false);
    if (blocker.state === "blocked") blocker.reset();
  }

  return (
    <AppDialog title="将棋レートマッチ" theme="shogi" busy={entering} onClose={requestClose}>
      <div className="flex flex-col gap-4">
        {identity && <ShogiRatingSummary key={identity} />}
        {data.status === "idle" && !pending && (
          <>
            <p className="text-sm">
              1人5分＋30秒。レートの近い人を優先し、15秒で相手が見つからなければCPUと組み合わせます。
            </p>
            <LegalNotice />
            {data.enabled === false && <p role="status">将棋レートマッチは準備中です。</p>}
          </>
        )}
        {searching && <p role="status">対戦相手を探しています…</p>}
        {assigned && owned && (
          <p role="status">対戦相手が決まりました。{entering && "ルームへ移動しています…"}</p>
        )}
        {data.status !== "idle" && !owned && (
          <p role="status">別のタブまたは端末でマッチング・対局中です。</p>
        )}
        {!showConfirm && (matching.error || account.error) && (
          <p role="alert" className="text-sm text-danger">
            {matching.error ?? account.error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <AppButton appearance="secondary" isDisabled={entering} onPress={requestClose}>
            戻る
          </AppButton>
          {data.status === "idle" &&
            !pending &&
            (data.enabled && !account.loading && !account.error && !identity ? (
              <AppButtonLink to="/login">ログイン・登録</AppButtonLink>
            ) : data.enabled && identity && !account.user?.profileCompleted ? (
              <AppButtonLink to="/account/setup">プロフィールを設定する</AppButtonLink>
            ) : (
              <AppButton isDisabled={!ready} onPress={() => void join()}>
                対戦相手を探す
              </AppButton>
            ))}
          {data.status !== "idle" && !owned && (
            <AppButton isDisabled={pending} onPress={() => void takeover()}>
              このタブで続ける
            </AppButton>
          )}
          {assigned && owned && !entering && (
            <AppButton onPress={() => void enter()}>入室する</AppButton>
          )}
          {!showConfirm && matching.error && (
            <AppButton appearance="secondary" onPress={() => void refresh()}>
              状態を確認する
            </AppButton>
          )}
        </div>
      </div>
      {showConfirm && (
        <AppDialog
          title="対戦相手を探すのをやめますか？"
          size="compact"
          theme="shogi"
          busy={cancelRequested && pending}
          onClose={continueSearch}
        >
          <p>閉じると対戦相手を探すのをやめます。</p>
          {matching.error && (
            <div className="mt-3 flex flex-col gap-2">
              <p role="alert" className="text-sm text-danger">
                {matching.error}
              </p>
              <AppButton appearance="secondary" size="compact" onPress={() => void refresh()}>
                状態を確認する
              </AppButton>
            </div>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <AppButton
              appearance="secondary"
              autoFocus
              isDisabled={cancelRequested && pending}
              onPress={continueSearch}
            >
              探し続ける
            </AppButton>
            <AppButton
              appearance="danger"
              isDisabled={pending}
              isPending={cancelRequested && pending}
              onPress={() => {
                setCancelRequested(true);
                void cancel();
              }}
            >
              探すのをやめる
            </AppButton>
          </div>
        </AppDialog>
      )}
    </AppDialog>
  );
}
