import { MatchHistory } from "./MatchHistory";
import { AccountStats } from "./AccountStats";
import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router";
import { AppHeader } from "../../shared/ui/AppHeader";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppDialog } from "../../shared/ui/AppDialog";
import type { AccountProfile } from "@tetraboard/protocol";
import { cn } from "@heroui/react";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { AccountMenu } from "./AccountMenu";
import { useAccount } from "./useAccount";
import { ProfileForm } from "./ProfileForm";
import { useGoogleSignIn } from "./useGoogleSignIn";
import {
  clearRegistrationReturn,
  readRegistrationReturn,
  saveRegistrationReturn,
} from "./registrationReturn";
import { useNavigate } from "react-router";
export function AccountPageShell({
  children,
  layout = "form",
}: {
  children: ReactNode;
  layout?: "form" | "profile";
}) {
  const profileLayout = layout === "profile";
  const lobbyLink = (
    <AppButtonLink
      to="/games/four-reversi"
      appearance="quiet"
      className={profileLayout ? "self-start" : undefined}
    >
      ロビーへ
    </AppButtonLink>
  );
  return (
    <div className="app-theme lobby-background min-h-dvh text-ink">
      <AppHeader homeTo="/games/four-reversi" homeLabel="TetraBoard ロビー">
        <AccountMenu />
      </AppHeader>
      <main
        className={cn(
          "flex flex-col gap-5 py-8",
          profileLayout ? appPageWidthClasses : "mx-auto max-w-[600px] px-5",
        )}
      >
        {profileLayout && lobbyLink}
        {children}
        {!profileLayout && lobbyLink}
      </main>
    </div>
  );
}
function AccountStatus() {
  const { error, refresh } = useAccount();
  return error ? (
    <AppCard>
      <p role="alert">{error}</p>
      <AppButton onPress={() => void refresh()}>再試行</AppButton>
    </AppCard>
  ) : (
    <p role="status">ログイン状態を確認しています…</p>
  );
}
export function LoginPage() {
  const { user, loading, error } = useAccount();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const google = useGoogleSignIn();
  const [destination] = useState(readRegistrationReturn);
  useEffect(() => {
    if (params.has("error") && destination) saveRegistrationReturn(destination, false);
  }, [params, destination]);
  if (!loading && !error && user && !params.has("error"))
    return <Navigate to={user.profileCompleted ? "/account" : "/account/setup"} replace />;
  return (
    <AccountPageShell>
      {loading || error ? (
        <AccountStatus />
      ) : (
        <AppCard>
          <AppCard.Header>
            <h1 className="text-2xl font-bold">登録・ログイン</h1>
            <p className="text-sm text-muted">GoogleアカウントでTetraBoardを利用できます。</p>
          </AppCard.Header>
          <AppCard.Content className="flex flex-col gap-5">
            <p className="text-sm">
              アカウントがない場合は、新しいユーザーが作成されます。続いて名前・ID・任意のアイコンを設定します。
            </p>
            {(google.message || params.has("error")) && (
              <p role="alert" className="text-sm text-danger">
                {google.message ??
                  "ログインを完了できませんでした。キャンセルした場合も、もう一度お試しいただけます。"}
              </p>
            )}
            <AppButton
              appearance="secondary"
              onPress={() => void google.start(destination ?? undefined)}
              isDisabled={google.busy}
            >
              {google.busy ? "Googleへ移動しています…" : "Googleで続ける"}
            </AppButton>
            {destination && (
              <AppButton
                appearance="quiet"
                isDisabled={google.busy}
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
  // ファイル選択からの復帰による再確認では、編集中のフォームを取り外しません。
  if (!user && (loading || error))
    return (
      <AccountPageShell layout={setup ? "form" : "profile"}>
        <AccountStatus />
      </AccountPageShell>
    );
  if (!user) return <Navigate to="/login" replace />;
  if (setup && user.profileCompleted) return <Navigate to="/account" replace />;
  if (!setup && !user.profileCompleted) return <Navigate to="/account/setup" replace />;
  if (!setup)
    return (
      <AccountPageShell layout="profile">
        {error && <AccountStatus />}
        <AccountProfileView user={user} />
      </AccountPageShell>
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
function AccountProfileView({ user }: { user: AccountProfile }) {
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
          <AccountStats />
        </AppCard>
        <MatchHistory />
      </div>
      {editing && (
        <AppDialog title="プロフィールを編集" busy={busy} onClose={() => setEditing(false)}>
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
