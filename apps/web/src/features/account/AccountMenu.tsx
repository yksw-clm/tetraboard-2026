import { gameCatalog, defaultGameId, type GameId } from "@tetraboard/protocol/games";
import { Dropdown } from "@heroui/react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppPendingIndicator, pendingButtonClasses } from "../../shared/ui/AppPendingIndicator";
import { AppIcon } from "../../shared/ui/AppIcon";
import { useAccount } from "./useAccount";
import { accountRequest } from "./accountApi";
import { createAccountSelection } from "./useAccountSelection";
import {
  clearRegistrationReturn,
  registrationPath,
  saveRegistrationReturn,
} from "./registrationReturn";
export function AccountMenu({ lobbyGame }: { lobbyGame?: GameId }) {
  const { user, loading, error, pendingSource, refresh } = useAccount();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
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
      clearRegistrationReturn();
      window.location.replace(gameCatalog[defaultGameId].lobbyPath);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "ログアウトできませんでした。");
      setBusy(false);
    }
  }
  if (loading && !error)
    return (
      <span className="text-xs text-muted" role="status">
        確認中…
      </span>
    );
  if (error)
    return (
      <AppButton
        appearance="quiet"
        size="compact"
        isDisabled={loading}
        isPending={pendingSource === "menu-retry"}
        onPress={() => void refresh("menu-retry")}
      >
        再試行
      </AppButton>
    );
  if (!user)
    return (
      <AppButtonLink
        to="/login"
        size="compact"
        onClick={() => {
          const path = registrationPath(location.pathname + location.search);
          if (path) saveRegistrationReturn({ path }, false);
          else clearRegistrationReturn();
        }}
      >
        登録・ログイン
      </AppButtonLink>
    );
  return (
    <div className="relative min-w-0">
      <Dropdown
        isOpen={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
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
              if (busy) return;
              if (key === "account")
                navigate(
                  user.profileCompleted ? "/account" : "/account/setup",
                  user.profileCompleted && lobbyGame
                    ? { state: { accountSelection: createAccountSelection(lobbyGame) } }
                    : undefined,
                );
              if (key === "logout") void logout();
            }}
          >
            <Dropdown.Item
              id="account"
              isDisabled={busy}
              textValue="マイページ"
              className="flex min-h-11 items-center gap-3 rounded-control px-3 text-sm cursor-pointer data-[focused=true]:bg-surface-hover"
            >
              <AppIcon name="user" />
              マイページ
            </Dropdown.Item>
            <Dropdown.Item
              id="logout"
              textValue="ログアウト"
              aria-label="ログアウト"
              shouldCloseOnSelect={false}
              isDisabled={busy}
              data-pending={busy || undefined}
              aria-busy={busy || undefined}
              className={`${pendingButtonClasses} flex min-h-11 items-center gap-3 rounded-control px-3 text-sm cursor-pointer data-[focused=true]:bg-surface-hover`}
            >
              <AppIcon name="leave" />
              ログアウト
              {busy && <AppPendingIndicator className="text-ink-secondary" />}
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
