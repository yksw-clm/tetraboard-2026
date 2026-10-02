import { useState, type ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router";
import { AppHeader } from "../../shared/ui/AppHeader";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AccountMenu } from "./AccountMenu";
import { useAccount } from "./useAccount";
import { accountRequest } from "./accountApi";
import { ProfileForm } from "./ProfileForm";
export function AccountPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-theme lobby-background min-h-dvh text-ink">
      <AppHeader homeTo="/games/four-reversi" homeLabel="TetraBoard ロビー">
        <AccountMenu />
      </AppHeader>
      <main className="mx-auto flex max-w-[600px] flex-col gap-5 px-5 py-8">
        {children}
        <AppButtonLink to="/games/four-reversi" appearance="quiet">
          ロビーへ
        </AppButtonLink>
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
      <AccountPageShell>
        <AccountStatus />
      </AccountPageShell>
    );
  if (!user) return <Navigate to="/login" replace />;
  if (setup && user.profileCompleted) return <Navigate to="/account" replace />;
  if (!setup && !user.profileCompleted) return <Navigate to="/account/setup" replace />;
  return (
    <AccountPageShell>
      <AppCard>
        <AppCard.Header>
          <h1 className="text-2xl font-bold">{setup ? "プロフィールを作成" : "マイページ"}</h1>
          <p className="text-sm text-muted">
            {setup
              ? "名前とIDを設定してください。アイコンは任意です。"
              : "名前・ID・アイコンを変更できます。"}
          </p>
        </AppCard.Header>
        <AppCard.Content>
          <ProfileForm user={user} setup={setup} />
        </AppCard.Content>
      </AppCard>
      {!setup && (
        <AppCard>
          <h2 className="text-lg font-bold">戦績・棋譜</h2>
          <p className="text-sm text-muted">今後追加予定です。</p>
        </AppCard>
      )}
    </AccountPageShell>
  );
}
