import { useEffect, useState, useRef } from "react";
import { useNavigate, useLocation } from "react-router";
import { AppHeader } from "../../shared/ui/AppHeader";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AccountMenu } from "../account/AccountMenu";
import { RoomIdentityFields } from "../account/RoomIdentityFields";
import { prepareRoomGuest } from "../account/guestAccount";
import { randomGuestAvatar } from "../account/guestAvatar";
import { useAccount } from "../account/useAccount";
import { LegalNotice } from "../privacy/LegalNotice";
import { readGuestName, saveGuestName } from "../../shared/guestName";
import { useMatchmaking } from "./useMatchmaking";
import type { MatchmakingGame } from "@tetraboard/protocol";
import { gameCatalog } from "@tetraboard/protocol/games";
import { appThemeClasses, gameThemes } from "../../shared/ui/appTheme";

export function MatchmakingPage({ game = "four-reversi" }: { game?: MatchmakingGame }) {
  const account = useAccount(),
    matching = useMatchmaking(game),
    navigate = useNavigate();
  const rated = game === "shogi";
  const title = rated ? "将棋レートマッチ" : "ランダムマッチ";
  const lobby = gameCatalog[game].lobbyPath;
  const theme = gameThemes[game];
  const location = useLocation();
  const [name, setName] = useState(readGuestName),
    [avatar, setAvatar] = useState(randomGuestAvatar);
  const [preparing, setPreparing] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const joinIntent = useRef<string | null>(null);
  const { identity: matchingIdentity, join } = matching;
  useEffect(() => {
    if (!preparing && joinIntent.current && joinIntent.current === matchingIdentity) {
      joinIntent.current = null;
      void join();
    }
  }, [preparing, matchingIdentity, join]);
  useEffect(() => {
    if (matching.data.status !== "idle" && account.user?.isGuest) saveGuestName(account.user.name);
  }, [matching.data.status, account.user]);
  const matchingStatus = matching.data.status,
    matchingEnabled = matching.data.enabled;
  useEffect(() => {
    if (
      location.state?.matchmakingRejoin &&
      matchingIdentity &&
      account.user?.profileCompleted &&
      matchingStatus === "idle" &&
      matchingEnabled
    ) {
      void navigate(location.pathname, { replace: true, state: null });
      void join();
    }
  }, [
    location,
    matchingIdentity,
    matchingStatus,
    matchingEnabled,
    join,
    navigate,
    account.user?.profileCompleted,
  ]);
  const elapsed =
    matching.data.joinedAtMs === undefined
      ? 0
      : Math.max(
          0,
          Math.floor(
            (matching.data.serverNowMs +
              Math.max(0, now - matching.data.receivedAtMs) -
              matching.data.joinedAtMs) /
              1000,
          ),
        );
  const status = matching.data.status,
    busy = preparing || matching.pending || account.loading || Boolean(account.error);
  async function start() {
    if (busy) return;
    if (rated) {
      await join();
      return;
    }
    setPreparing(true);
    setMessage(null);
    try {
      const user = await prepareRoomGuest(
        name,
        account.user,
        account.user?.nameCustomized || (!account.user?.isGuest && account.user)
          ? undefined
          : avatar,
        account.update,
      );
      if (!user.profileCompleted) {
        void navigate("/account/setup");
        return;
      }
      if (user.profileId === matchingIdentity) await join();
      else joinIntent.current = user.profileId!;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "参加情報を確認してください。");
    } finally {
      setPreparing(false);
    }
  }
  async function leave() {
    if (status !== "idle") {
      await matching.cancel();
      return;
    }
    void navigate(lobby);
  }
  return (
    <div
      className={`app-theme min-h-dvh text-ink ${appThemeClasses[theme]} ${rated ? "lobby-background" : "bg-[#f0f6f2]"}`}
    >
      <AppHeader homeTo="/" homeLabel="TetraBoard" theme={theme}>
        <AccountMenu lobbyGame={game} />
      </AppHeader>
      <main className="mx-auto flex max-w-xl flex-col gap-5 px-5 py-8">
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="text-sm text-muted">
          {rated ? "1人5分＋30秒の秒読み" : "四人リバーシ・シングルス／レートなし／1人3分切れ負け"}
        </p>
        <AppCard className="gap-4 p-5">
          {status === "idle" ? (
            <>
              <p className="text-sm">
                {rated
                  ? "レートの近い人を優先します。15秒で相手が見つからない場合は、実力の近いCPUと対局します。"
                  : "人間同士を優先して対戦相手を探します。30秒で4人に満たない場合は、CPU「ヨミ」（Lv3）が不足席に参加します。"}
              </p>
              <p className="text-xs text-muted">
                {rated
                  ? "対人戦・CPU戦ともにレートの対象です。有効な5局で認定され、対局・棋譜は公開されます。"
                  : "秒読みはありません。CPUを含む対局は履歴・棋譜に残り、対人戦績には反映されません。対局・棋譜は公開されます。"}
              </p>
              {!rated && (
                <RoomIdentityFields
                  name={name}
                  onChange={setName}
                  busy={busy}
                  avatarPresetId={avatar}
                  onAvatarChange={setAvatar}
                />
              )}
              <LegalNotice />
              {matching.data.enabled === false && (
                <p role="status" className="text-sm text-muted">
                  {title}は準備中です。
                </p>
              )}
              {rated && matching.data.enabled === true && !busy && !matchingIdentity ? (
                <>
                  <p className="text-sm">参加には登録アカウントが必要です。</p>
                  <AppButtonLink to="/login">ログイン・登録</AppButtonLink>
                </>
              ) : rated && matchingIdentity && !account.user?.profileCompleted ? (
                <AppButtonLink to="/account/setup">プロフィールを設定する</AppButtonLink>
              ) : (
                <AppButton
                  isDisabled={busy || matching.data.enabled !== true}
                  isPending={busy}
                  onPress={() => void start()}
                >
                  対戦相手を探す
                </AppButton>
              )}
            </>
          ) : matching.owned ? (
            <>
              <p role="status" className="font-bold">
                {status === "waiting"
                  ? "対戦相手を探しています…"
                  : status === "playing"
                    ? "対局へ戻れます。"
                    : "対戦相手が決まりました。"}
              </p>
              {status === "waiting" ? (
                <>
                  <p className="text-sm tabular-nums">待機時間：{elapsed}秒</p>
                  <p className="text-xs text-muted">
                    {rated
                      ? "条件に合う人がいなければ、15秒でCPUと組み合わせます。"
                      : "4人がそろうか、30秒経過すると組合せを決めます。"}
                  </p>
                </>
              ) : (
                <>
                  {rated && matching.data.assignment?.opponent && (
                    <p className="text-sm font-semibold">
                      {matching.data.assignment?.opponent === "cpu" ? "CPU戦" : "対人戦"}
                      ・5分＋30秒・レート対象
                    </p>
                  )}
                  <p className="text-sm">入室後、全員の接続を確認して5秒後に開始します。</p>
                  <AppButton onPress={() => void matching.enter()} isDisabled={busy}>
                    入室する
                  </AppButton>
                </>
              )}
              {status !== "playing" && (
                <AppButton
                  appearance="secondary"
                  isDisabled={busy}
                  isPending={matching.pending}
                  onPress={() => void matching.cancel()}
                >
                  取り消す
                </AppButton>
              )}
            </>
          ) : (
            <>
              <p role="status" className="text-sm">
                別のタブまたは端末でマッチング・対局中です。
              </p>
              <AppButton isDisabled={busy} onPress={() => void matching.takeover()}>
                このタブで続ける
              </AppButton>
            </>
          )}
          {(message || matching.error) && (
            <div role="alert" className="flex flex-col gap-2 text-sm text-danger">
              <p>{message ?? matching.error}</p>
              <AppButton
                appearance="secondary"
                size="compact"
                onPress={() => void matching.refresh()}
              >
                状態を確認する
              </AppButton>
            </div>
          )}
        </AppCard>
        {status === "idle" || !matching.owned || status === "playing" ? (
          <AppButtonLink to={lobby} appearance="secondary">
            ロビーへ戻る
          </AppButtonLink>
        ) : (
          <AppButton appearance="quiet" isDisabled={busy} onPress={() => void leave()}>
            マッチングを取り消す
          </AppButton>
        )}
      </main>
    </div>
  );
}
