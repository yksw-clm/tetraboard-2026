import { Dropdown } from "@heroui/react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import { useAccount } from "./useAccount";
import { accountRequest } from "./accountApi";
export function AccountMenu() {
  const { user, loading, error, refresh } = useAccount();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function logout() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await accountRequest("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      // Cookie失効後の画面と認証状態を同じページ読み込みで確定します。
      window.location.replace("/games/four-reversi");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "ログアウトできませんでした。");
      setBusy(false);
    }
  }
  if (loading)
    return (
      <span className="text-xs text-muted" role="status">
        確認中…
      </span>
    );
  if (error)
    return (
      <AppButton appearance="quiet" size="compact" onPress={() => void refresh()}>
        再試行
      </AppButton>
    );
  if (!user)
    return (
      <AppButtonLink to="/login" size="compact">
        ログイン
      </AppButtonLink>
    );
  return (
    <div className="relative min-w-0">
      <Dropdown>
        <Dropdown.Trigger
          aria-label={`${user.name || "プロフィール未設定"}のアカウントメニュー`}
          isDisabled={busy}
          className="flex min-h-12 max-w-[290px] items-center gap-3 rounded-full border border-solid border-line bg-white p-1.5 pr-3 text-ink cursor-pointer [@media(max-width:650px)]:gap-1.5 [@media(max-width:650px)]:pr-2"
        >
          <AppAvatar src={user.avatarUrl} />
          <span className="min-w-0 text-left [@media(max-width:650px)]:hidden">
            <span className="block truncate text-[15px] font-bold leading-tight">
              {user.name || "プロフィール未設定"}
            </span>
            <span className="mt-1 block truncate text-xs text-muted leading-tight">
              {user.username ? `@${user.username}` : "初回設定をしてください"}
            </span>
          </span>
          <AppIcon name="chevronDown" className="size-4 text-muted" />
        </Dropdown.Trigger>
        <Dropdown.Popover
          placement="bottom end"
          className="app-theme w-48 rounded-panel border border-solid border-line bg-white p-1.5 shadow-dialog"
        >
          <Dropdown.Menu
            aria-label="アカウントメニュー"
            onAction={(key) => {
              if (key === "account")
                navigate(user.profileCompleted ? "/account" : "/account/setup");
              if (key === "logout") void logout();
            }}
          >
            <Dropdown.Item
              id="account"
              textValue="マイページ"
              className="flex min-h-11 items-center gap-3 rounded-control px-3 text-sm cursor-pointer data-[focused=true]:bg-surface-hover"
            >
              <AppIcon name="user" />
              マイページ
            </Dropdown.Item>
            <Dropdown.Item
              id="logout"
              textValue="ログアウト"
              className="flex min-h-11 items-center gap-3 rounded-control px-3 text-sm cursor-pointer data-[focused=true]:bg-surface-hover"
            >
              <AppIcon name="leave" />
              ログアウト
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      {message && (
        <p
          role="alert"
          className="absolute right-0 top-full z-10 w-64 rounded-control bg-white p-3 text-sm text-danger shadow-panel"
        >
          {message}
        </p>
      )}
    </div>
  );
}
