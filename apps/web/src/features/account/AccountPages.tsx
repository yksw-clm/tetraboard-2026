import { RegistrationBenefits, RegistrationBadgeExamples } from "./RegistrationBenefits";
import { SocialSignInButtons } from "./SocialSignInButtons";
import {
  gameCatalog,
  gameIds,
  defaultGameId,
  isGameId,
  type GameId,
} from "@tetraboard/protocol/games";
import { MatchHistory } from "./MatchHistory";
import { AccountStats } from "./AccountStats";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router";
import { AppHeader } from "../../shared/ui/AppHeader";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppDialog } from "../../shared/ui/AppDialog";
import type { AccountProfile, RoomMode } from "@tetraboard/protocol";
import { cn, Dropdown } from "@heroui/react";
import { AppIcon } from "../../shared/ui/AppIcon";
import { AppTabs } from "../../shared/ui/AppTabs";
import { appThemeClasses, gameThemes } from "../../shared/ui/appTheme";
import { useAccountSelection } from "./useAccountSelection";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { AccountMenu } from "./AccountMenu";
import { useAccount } from "./useAccount";
import { ProfileForm } from "./ProfileForm";
import { useSocialSignIn } from "./useSocialSignIn";
import {
  clearRegistrationReturn,
  readRegistrationReturn,
  saveRegistrationReturn,
} from "./registrationReturn";
import { useNavigate } from "react-router";
export function AccountPageShell({
  children,
  layout = "form",
  game = defaultGameId,
  navigation,
  modeTabs,
}: {
  children: ReactNode;
  layout?: "form" | "profile" | "login";
  game?: GameId;
  navigation?: ReactNode;
  modeTabs?: ReactNode;
}) {
  const profileLayout = layout === "profile";
  const loginLayout = layout === "login";
  const lobbyLink = (
    <AppButtonLink
      to={gameCatalog[profileLayout ? game : defaultGameId].lobbyPath}
      appearance={profileLayout ? "secondary" : "quiet"}
      className={
        profileLayout
          ? "col-start-2 row-start-1 justify-self-end [@media(min-width:651px)]:col-start-3"
          : undefined
      }
    >
      ロビーへ
    </AppButtonLink>
  );
  return (
    <div
      className={cn(
        "app-theme min-h-dvh text-ink",
        !profileLayout && "lobby-background",
        loginLayout && "flex flex-col",
      )}
    >
      <AppHeader homeTo={gameCatalog[defaultGameId].lobbyPath} homeLabel="TetraBoard ロビー">
        <AccountMenu />
      </AppHeader>
      <div
        className={
          profileLayout
            ? cn(
                "lobby-background text-ink min-h-[calc(100dvh-69px)] [@media(max-width:650px)]:min-h-[calc(100dvh-61px)]",
                appThemeClasses[gameThemes[game]],
              )
            : "contents"
        }
      >
        <main
          className={cn(
            "flex flex-col gap-5 py-8",
            profileLayout
              ? appPageWidthClasses
              : loginLayout
                ? "mx-auto w-full max-w-[600px] flex-1 justify-center px-5"
                : "mx-auto max-w-[600px] px-5",
          )}
        >
          {profileLayout && (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-5 [@media(min-width:651px)]:grid-cols-[auto_minmax(0,1fr)_auto]">
              <div className="col-start-1 row-start-1">{navigation}</div>
              {modeTabs && (
                <div className="col-span-2 col-start-1 row-start-2 min-w-0 [@media(min-width:651px)]:col-span-1 [@media(min-width:651px)]:col-start-2 [@media(min-width:651px)]:row-start-1 [@media(min-width:651px)]:max-w-[360px]">
                  {modeTabs}
                </div>
              )}
              {lobbyLink}
            </div>
          )}
          {children}
          {!profileLayout && (
            <div className={loginLayout ? "text-center" : undefined}>{lobbyLink}</div>
          )}
        </main>
      </div>
    </div>
  );
}
function AccountGameMenu({ game, onChange }: { game: GameId; onChange: (game: GameId) => void }) {
  return (
    <Dropdown>
      <AppButton appearance="secondary" aria-label={`ゲームを選択：${gameCatalog[game].name}`}>
        {gameCatalog[game].name}
        <AppIcon name="chevronDown" className="size-4" />
      </AppButton>
      <Dropdown.Popover
        placement="bottom start"
        className={cn(
          "app-theme min-w-48 rounded-panel border border-solid border-line bg-white p-1.5 text-ink shadow-dialog",
          appThemeClasses[gameThemes[game]],
        )}
      >
        <Dropdown.Menu
          aria-label="プロフィールのゲーム"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[game]}
          onSelectionChange={(keys) => {
            if (keys === "all") return;
            const next = [...keys][0];
            if (isGameId(next)) onChange(next);
          }}
        >
          {gameIds.map((id) => (
            <Dropdown.Item
              key={id}
              id={id}
              textValue={gameCatalog[id].name}
              className="flex min-h-11 items-center justify-between gap-3 rounded-control px-3 text-sm cursor-pointer data-[focused=true]:bg-surface-hover"
            >
              {gameCatalog[id].name}
              <Dropdown.ItemIndicator />
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
function AccountStatus() {
  const { error, loading, pendingSource, refresh } = useAccount();
  return error ? (
    <AppCard>
      <p role="alert">{error}</p>
      <AppButton
        isDisabled={loading}
        isPending={pendingSource === "page-retry"}
        onPress={() => void refresh("page-retry")}
      >
        再試行
      </AppButton>
    </AppCard>
  ) : (
    <p role="status">ログイン状態を確認しています…</p>
  );
}
export function LoginPage() {
  const { user, loading, error } = useAccount();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const signIn = useSocialSignIn();
  const [destination] = useState(readRegistrationReturn);
  const adminDestination = params.get("destination") === "admin";
  useEffect(() => {
    if (params.has("error") && destination && !adminDestination)
      saveRegistrationReturn(destination, false);
  }, [params, destination, adminDestination]);
  useEffect(() => {
    if (!loading && !error && user && adminDestination && !params.has("error"))
      window.location.replace("/admin");
  }, [loading, error, user, adminDestination, params]);
  if (!loading && !error && user && !params.has("error")) {
    if (adminDestination) return <p role="status">管理画面へ移動しています…</p>;
    return <Navigate to={user.profileCompleted ? "/account" : "/account/setup"} replace />;
  }
  return (
    <AccountPageShell layout="login">
      {loading || error ? (
        <AccountStatus />
      ) : (
        <AppCard className="gap-6 p-6">
          <AppCard.Header className="items-center text-center">
            <h1 className="text-2xl font-bold">
              {adminDestination ? "管理画面へログイン" : "登録・ログイン"}
            </h1>
            <p className="text-sm text-muted">
              {adminDestination
                ? "Googleアカウントでログインしてください。"
                : "対局の楽しさを、自分のアカウントに。"}
            </p>
          </AppCard.Header>
          <AppCard.Content className="flex flex-col gap-5">
            {!adminDestination && (
              <>
                <RegistrationBenefits />
                <div className="@container rounded-panel bg-surface-muted p-3">
                  <div className="grid grid-cols-1 gap-3 @min-[300px]:grid-cols-2">
                    {(["four-reversi", "four-shogi"] as const).map((exampleGame) => (
                      <div key={exampleGame} className="flex min-w-0 flex-col items-center gap-1">
                        <span className="text-xs font-bold">{gameCatalog[exampleGame].name}</span>
                        <RegistrationBadgeExamples game={exampleGame} />
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
            {(signIn.message || params.has("error")) && (
              <p role="alert" className="text-sm text-danger">
                {signIn.message ??
                  (params.get("error") === "email_not_found"
                    ? "Discordからメールアドレスを取得できませんでした。メールを設定したDiscordアカウントか、Googleで続けてください。"
                    : params.get("error") === "account_not_linked"
                      ? "このメールアドレスは別の方法で登録されています。最初に登録した方法でログインしてください。アカウントの自動連携は行いません。"
                      : "ログインを完了できませんでした。キャンセルした場合も、もう一度お試しいただけます。")}
              </p>
            )}
            <SocialSignInButtons
              onSignIn={(provider) =>
                void signIn.start(provider, adminDestination ? "admin" : (destination ?? undefined))
              }
              adminOnly={adminDestination}
              busy={signIn.busy}
              pendingProvider={signIn.pendingProvider}
            />
            {!adminDestination && (
              <p className="m-0 text-xs leading-relaxed text-muted">
                初めて利用する場合はアカウントを作成し、名前・ID・任意のアイコンを設定します。登録せずに遊ぶこともできます。
              </p>
            )}
            {destination && !adminDestination && (
              <AppButton
                appearance="quiet"
                isDisabled={signIn.busy}
                onPress={() => {
                  clearRegistrationReturn();
                  void navigate(destination.path, {
                    state: { registrationReturn: destination },
                    replace: true,
                  });
                }}
              >
                元の画面へ戻る
              </AppButton>
            )}
          </AppCard.Content>
        </AppCard>
      )}
    </AccountPageShell>
  );
}
export function ProfilePage({ setup = false }: { setup?: boolean }) {
  const { user, loading, error } = useAccount();
  const { game, mode, setGame, setMode } = useAccountSelection();
  const panelId = useId();
  // ファイル選択からの復帰による再確認では、編集中のフォームを取り外しません。
  if (!user && (loading || error))
    return (
      <AccountPageShell
        layout={setup ? "form" : "profile"}
        game={game}
        navigation={!setup && <AccountGameMenu game={game} onChange={setGame} />}
      >
        <AccountStatus />
      </AccountPageShell>
    );
  if (!user) return <Navigate to="/login" replace />;
  if (setup && user.profileCompleted) return <Navigate to="/account" replace />;
  if (!setup && !user.profileCompleted) return <Navigate to="/account/setup" replace />;
  if (!setup)
    return (
      <AppTabs
        selectedKey={mode}
        onSelectionChange={(key) => setMode(key as RoomMode)}
        className="contents"
      >
        <AccountPageShell
          layout="profile"
          game={game}
          navigation={<AccountGameMenu game={game} onChange={setGame} />}
          modeTabs={
            game !== "reversi" && (
              <AppTabs.List aria-label="プロフィールの対局モード">
                {(["singles", "doubles"] as const).map((tab) => (
                  <AppTabs.Tab
                    key={tab}
                    id={tab}
                    render={(props) =>
                      "href" in props ? (
                        <a
                          {...props}
                          aria-controls={props["aria-selected"] ? panelId : undefined}
                        />
                      ) : (
                        <div
                          {...props}
                          aria-controls={props["aria-selected"] ? panelId : undefined}
                        />
                      )
                    }
                  >
                    {tab === "singles" ? "シングルス" : "ダブルス"}
                    <AppTabs.Indicator />
                  </AppTabs.Tab>
                ))}
              </AppTabs.List>
            )
          }
        >
          {error && <AccountStatus />}
          {/* 選択パネルを取り外さず、タブの参照先を同じDOMにそろえます。 */}
          <AppTabs.Panel id={mode} render={(props) => <div {...props} id={panelId} />}>
            <AccountProfileView user={user} game={game} mode={mode} />
          </AppTabs.Panel>
        </AccountPageShell>
      </AppTabs>
    );
  return (
    <AccountPageShell>
      {error && <AccountStatus />}
      <AppCard>
        <AppCard.Header>
          <h1 className="text-2xl font-bold">プロフィールを作成</h1>
          <p className="text-sm text-muted">名前とIDを設定してください。アイコンは任意です。</p>
        </AppCard.Header>
        <AppCard.Content>
          <ProfileForm user={user} setup />
        </AppCard.Content>
      </AppCard>
    </AccountPageShell>
  );
}
function AccountProfileView({
  user,
  game,
  mode,
}: {
  user: AccountProfile;
  game: GameId;
  mode: RoomMode;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <div className="grid min-w-0 grid-cols-1 items-start gap-5 [@media(min-width:1024px)]:grid-cols-[560px_minmax(0,1fr)]">
        <AppCard data-testid="account-profile-card">
          <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-x-4 gap-y-5 [@media(min-width:651px)]:grid-cols-[64px_minmax(0,1fr)_auto]">
            <AppButton
              appearance="secondary"
              className="col-span-2 row-start-1 justify-self-end [@media(min-width:651px)]:col-span-1 [@media(min-width:651px)]:col-start-3 [@media(min-width:651px)]:self-start"
              onPress={() => {
                setNotice(null);
                setEditing(true);
              }}
            >
              プロフィールを編集
            </AppButton>
            <AppAvatar
              src={user.avatarUrl}
              label="プロフィールアイコン"
              className="col-start-1 row-start-2 size-16 [&_svg]:size-7 [@media(min-width:651px)]:row-start-1"
            />
            <div className="col-start-2 row-start-2 min-w-0 [@media(min-width:651px)]:row-start-1">
              <h1 className="text-xl font-bold [overflow-wrap:anywhere]">{user.name}</h1>
              <p className="mt-1 text-sm text-muted [overflow-wrap:anywhere]">@{user.username}</p>
            </div>
          </div>
          {notice && (
            <p role="status" className="text-sm text-brand">
              {notice}
            </p>
          )}
          <AccountStats game={game} mode={mode} />
        </AppCard>
        <MatchHistory game={game} mode={mode} />
      </div>
      {editing && (
        <AppDialog
          title="プロフィールを編集"
          theme={gameThemes[game]}
          busy={busy}
          onClose={() => setEditing(false)}
        >
          <ProfileForm
            user={user}
            setup={false}
            onBusyChange={setBusy}
            onSaved={() => {
              setEditing(false);
              setNotice("プロフィールを保存しました。");
            }}
          />
        </AppDialog>
      )}
    </>
  );
}
