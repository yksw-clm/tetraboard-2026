import { MatchHistory } from "./MatchHistory";
import { AccountStats } from "./AccountStats";
import { useState, type ReactNode } from "react";
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
import { accountRequest } from "./accountApi";
import { ProfileForm } from "./ProfileForm";
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!loading && !error && user)
    return <Navigate to={user.profileCompleted ? "/account" : "/account/setup"} replace />;
  async function login() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = (await accountRequest("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })) as { url?: string };
      if (!result.url || new URL(result.url).origin !== "https://accounts.google.com")
        throw new Error("Googleログインを開始できませんでした。");
      window.location.assign(result.url);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Googleログインを開始できませんでした。");
      setBusy(false);
    }
  }
  return (
    <AccountPageShell>
      {loading || error ? (
        <AccountStatus />
      ) : (
        <AppCard>
          <AppCard.Header>
            <h1 className="text-2xl font-bold">ログイン</h1>
            <p className="text-sm text-muted">GoogleアカウントでTetraBoardを利用できます。</p>
          </AppCard.Header>
          <AppCard.Content className="flex flex-col gap-5">
            <p className="text-sm">
              アカウントがない場合は、新しいユーザーが作成されます。続いて名前・ID・任意のアイコンを設定します。
            </p>
            {(message || params.has("error")) && (
              <p role="alert" className="text-sm text-danger">
                {message ??
                  "ログインを完了できませんでした。キャンセルした場合も、もう一度お試しいただけます。"}
              </p>
            )}
            <AppButton appearance="secondary" onPress={() => void login()} isDisabled={busy}>
              {busy ? "Googleへ移動しています…" : "Googleで続ける"}
            </AppButton>
          </AppCard.Content>
        </AppCard>
      )}
    </AccountPageShell>
  );
}
export function ProfilePage({ setup = false }: { setup?: boolean }) {
  const { user, loading, error } = useAccount();
  if (loading || error)
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
        <AccountProfileView user={user} />
      </AccountPageShell>
    );
  return (
    <AccountPageShell>
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
