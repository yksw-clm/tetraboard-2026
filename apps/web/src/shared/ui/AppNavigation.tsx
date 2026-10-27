import { useContext, useEffect, useSyncExternalStore, type MouseEvent } from "react";
import { Link, useLocation } from "react-router";
import { cn } from "@heroui/react";
import { defaultGameId, gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { AccountContext } from "../../features/account/useAccount";
import { createAccountSelection } from "../../features/account/useAccountSelection";
import {
  clearRegistrationReturn,
  registrationPath,
  saveRegistrationReturn,
} from "../../features/account/registrationReturn";
import { LobbyBoardPreview } from "../../features/lobby/LobbyBoardPreview";
import { lastLobbyGame, lobbyGameForNavigation } from "../lastLobbyGame";
import { isGameViewPath } from "../siteNavigation";
import { AppAvatar } from "./AppAvatar";
import { AppIcon } from "./AppIcon";

export function LastLobbyGameTracker() {
  const { pathname } = useLocation();
  useEffect(() => lastLobbyGame.visit(pathname), [pathname]);
  return null;
}

export type AppNavigationHandler = (to: string, state?: unknown) => void;

export function AppNavigation({
  mobile = false,
  onNavigate,
}: {
  mobile?: boolean;
  onNavigate?: AppNavigationHandler;
}) {
  const location = useLocation();
  const game = useSyncExternalStore<GameId>(
    lastLobbyGame.subscribe,
    lastLobbyGame.getSnapshot,
    () => defaultGameId,
  );
  const account = useContext(AccountContext);
  const user = account?.user;
  const accountAvatar = user && !user.isGuest ? user.avatarUrl : null;
  const accountTo = user
    ? user.profileCompleted
      ? "/account"
      : "/account/setup"
    : account?.loading || account?.error
      ? "/account"
      : "/login";
  const accountState = user?.profileCompleted
    ? { accountSelection: createAccountSelection(game) }
    : undefined;
  function navigateFromLink(event: MouseEvent<HTMLAnchorElement>, to: string, state?: unknown) {
    if (
      !onNavigate ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (event.currentTarget.target && event.currentTarget.target !== "_self")
    )
      return;
    event.preventDefault();
    onNavigate(to, state);
  }
  const links = [
    { to: "/", label: "ホーム", icon: <AppIcon name="home" />, active: location.pathname === "/" },
    {
      to: "/how-to-play",
      label: "遊び方",
      icon: <AppIcon name="book" />,
      active: location.pathname.replace(/\/$/, "") === "/how-to-play",
    },
    {
      to: gameCatalog[game].lobbyPath,
      label: gameCatalog[game].name,
      icon: (
        <span className="grid size-6 place-items-center [&_img]:w-5 [&_img]:max-h-6 [&_img]:object-contain [&_img]:rotate-0 [&_img]:shadow-none">
          <LobbyBoardPreview game={game} compact />
        </span>
      ),
      active: lobbyGameForNavigation(location.pathname) === game,
    },
  ];
  if (isGameViewPath(location.pathname)) return null;
  return (
    <nav
      aria-label={mobile ? "下部ナビゲーション" : "メインナビゲーション"}
      className={
        mobile
          ? "app-theme fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 gap-1 border-t border-solid border-line bg-white px-2 pt-1 pb-[calc(4px+env(safe-area-inset-bottom))] [@media(min-width:768px)]:hidden"
          : "flex self-stretch items-center gap-1 [@media(max-width:767px)]:hidden"
      }
    >
      {links.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          onClick={(event) => navigateFromLink(event, link.to)}
          aria-current={link.active ? "page" : undefined}
          className={cn(
            "flex shrink-0 items-center justify-center gap-2 text-sm font-bold no-underline",
            mobile
              ? "min-h-14 min-w-0 flex-col gap-1 rounded-xl px-1 py-1 text-[11px]"
              : "min-h-[56px] border-b-2 border-solid px-3 [@media(max-width:1023px)]:gap-1 [@media(max-width:1023px)]:px-2 [@media(max-width:1023px)]:text-xs",
            link.active
              ? mobile
                ? "bg-surface-hover text-brand"
                : "border-brand text-brand"
              : mobile
                ? "text-muted hover:bg-surface-hover"
                : "border-transparent text-muted hover:text-brand",
          )}
        >
          {link.icon}
          <span>{link.label}</span>
        </Link>
      ))}
      {mobile && (
        <Link
          to={accountTo}
          state={accountState}
          aria-current={
            location.pathname.startsWith("/account") || location.pathname === "/login"
              ? "page"
              : undefined
          }
          onClick={(event) => {
            if (accountTo === "/login") {
              const path = registrationPath(location.pathname + location.search);
              if (path) saveRegistrationReturn({ path }, false);
              else clearRegistrationReturn();
            }
            navigateFromLink(event, accountTo, accountState);
          }}
          className={cn(
            "flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1 text-[11px] font-bold no-underline",
            location.pathname.startsWith("/account") || location.pathname === "/login"
              ? "bg-surface-hover text-brand"
              : "text-muted hover:bg-surface-hover",
          )}
        >
          {accountAvatar ? (
            <AppAvatar src={accountAvatar} className="size-6 [&_svg]:size-4" />
          ) : (
            <span className="grid size-6 place-items-center rounded-full bg-surface-hover">
              <AppIcon name="user" className="size-4" />
            </span>
          )}
          <span>アカウント</span>
        </Link>
      )}
    </nav>
  );
}
