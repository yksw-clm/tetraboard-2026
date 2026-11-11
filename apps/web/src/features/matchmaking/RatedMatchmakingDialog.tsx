import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker, useLocation, useNavigate } from "react-router";
import type { RatedMatchmakingGame } from "@tetraboard/protocol";
import { gameCatalog } from "@tetraboard/protocol/games";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppDialog } from "../../shared/ui/AppDialog";
import { gameThemes } from "../../shared/ui/appTheme";
import { SocialSignInButtons } from "../account/SocialSignInButtons";
import { useAccount } from "../account/useAccount";
import { useSocialSignIn } from "../account/useSocialSignIn";
import { RatingSummary } from "./RatingSummary";
import { RatingGrowthPreview } from "./RatingGrowthPreview";
import { useMatchmaking } from "./useMatchmaking";

export function RatedMatchmakingDialog({ game }: { game: RatedMatchmakingGame }) {
  const account = useAccount();
  const signIn = useSocialSignIn();
  const matching = useMatchmaking(game);
  const theme = gameThemes[game];
  const title = `${gameCatalog[game].name}のレート戦`;
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
      (searching || entering || signIn.busy) &&
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
    if (
      location.state?.matchmakingFromLobby === true ||
      location.state?.shogiMatchmakingFromLobby === true
    ) {
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
    if (
      join(() => {
        void navigate(location.pathname + location.search + location.hash, {
          replace: true,
          state: null,
        });
      })
    )
      rejoin.current = false;
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
  const showSignIn =
    data.status === "idle" &&
    !pending &&
    data.enabled &&
    !account.loading &&
    !account.error &&
    !identity;
  function requestClose() {
    if (signIn.busy) return;
    if (searching) setConfirm(true);
    else close();
  }
  function continueSearch() {
    setConfirm(false);
    setCancelRequested(false);
    if (blocker.state === "blocked") blocker.reset();
  }

  return (
    <AppDialog title={title} theme={theme} busy={entering || signIn.busy} onClose={requestClose}>
      <div className="flex flex-col gap-4">
        {showSignIn && (
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <RatingGrowthPreview key={game} />
            <h3 className="m-0 text-xl font-bold leading-relaxed">
              アカウントを連携して、<span className="inline-block">レート戦に挑戦！</span>
            </h3>
            <p className="text-sm leading-relaxed text-muted">
              対局でレートを上げて、<span className="inline-block">ランキング上位を目指そう！</span>
            </p>
          </div>
        )}
        {identity && <RatingSummary key={`${game}:${identity}`} game={game} />}
        {data.status === "idle" && !pending && data.enabled === false && (
          <p role="status">{title}は準備中です。</p>
        )}
        {searching && <p role="status">対戦相手を探しています…</p>}
        {identity && data.enabled && !assigned && data.waitingCount !== undefined && (
          <p className="text-sm">{data.waitingCount}人が待機中</p>
        )}
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
        <div className="flex flex-col gap-2">
          {data.status === "idle" &&
            !pending &&
            (showSignIn ? (
              <>
                <SocialSignInButtons
                  busy={signIn.busy}
                  pendingProvider={signIn.pendingProvider}
                  consentBelowButtons
                  layout="vertical"
                  onSignIn={(provider) =>
                    void signIn.start(provider, {
                      path: `${gameCatalog[game].lobbyPath}?matchmaking=1`,
                    })
                  }
                />
                {signIn.message && (
                  <p role="alert" className="text-sm text-danger">
                    {signIn.message}
                  </p>
                )}
              </>
            ) : data.enabled && identity && !account.user?.profileCompleted ? (
              <AppButtonLink to="/account/setup">プロフィールを設定する</AppButtonLink>
            ) : (
              <AppButton className="w-full" isDisabled={!ready} onPress={() => void join()}>
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
            <AppButton
              appearance="secondary"
              isDisabled={signIn.busy}
              onPress={() => void refresh()}
            >
              状態を確認する
            </AppButton>
          )}
          <AppButton
            className="w-full"
            appearance="secondary"
            isDisabled={entering || signIn.busy}
            onPress={requestClose}
          >
            戻る
          </AppButton>
        </div>
      </div>
      {showConfirm && (
        <AppDialog
          title="対戦相手を探すのをやめますか？"
          size="compact"
          theme={theme}
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
