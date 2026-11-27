import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { useLayoutEffect, useRef, type MouseEvent } from "react";
import { Link, useLocation, useNavigationType } from "react-router";
import { getTournamentSettings } from "@tetraboard/protocol";
import { lobbyTabParam } from "./useMobileLobby";
import { useActiveTournaments } from "../tournaments/useActiveTournaments";

const tabs = [
  { id: "play", label: "対局" },
  { id: "rankings", label: "ランキング" },
  { id: "posts", label: "投稿" },
  { id: "tournaments", label: "大会" },
] as const;
type LobbyTab = (typeof tabs)[number]["id"];

export function MobileLobbyNavigation({
  game,
  selected,
  onLeave,
}: {
  game: GameId;
  selected: LobbyTab;
  onLeave?: () => void;
}) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const activeLink = useRef<HTMLAnchorElement>(null);
  const { tournaments, upcoming, serverNowMs } = useActiveTournaments();
  const status = tournaments.some((item) => getTournamentSettings(item).game === game)
    ? "開催中"
    : upcoming.some(
          (item) =>
            item.status === "upcoming" &&
            item.startsAtMs > serverNowMs &&
            getTournamentSettings(item).game === game,
        )
      ? "受付中"
      : null;

  useLayoutEffect(() => {
    if (navigationType !== "PUSH" || location.state?.lobbyTabNavigation !== true) return;
    if (document.activeElement === document.body)
      activeLink.current?.focus({ preventScroll: true });
  }, [location, navigationType]);

  const lobbyPath = gameCatalog[game].lobbyPath;
  const onLobby = location.pathname.replace(/\/$/, "") === lobbyPath;
  function select(event: MouseEvent<HTMLAnchorElement>, current: boolean) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    if (current) event.preventDefault();
    else onLeave?.();
  }

  return (
    <nav
      aria-label="ゲームロビー"
      className="sticky top-0 z-10 grid grid-cols-4 rounded-b-control border-b border-solid border-line bg-white shadow-sm"
    >
      {tabs.map(({ id, label }) => {
        const current = selected === id;
        const search = new URLSearchParams(onLobby ? location.search : "");
        search.delete(lobbyTabParam);
        if (id === "rankings" || id === "tournaments") search.set(lobbyTabParam, id);
        return (
          <Link
            key={id}
            ref={current ? activeLink : undefined}
            to={
              id === "posts"
                ? `${lobbyPath}/posts`
                : {
                    pathname: lobbyPath,
                    search: search.toString(),
                    hash: onLobby ? location.hash : "",
                  }
            }
            state={{
              ...(id !== "posts" && onLobby ? location.state : null),
              scrollToTop: true,
              lobbyTabNavigation: true,
            }}
            aria-current={current ? "page" : undefined}
            onClick={(event) => select(event, current)}
            className="relative flex min-h-12 min-w-0 flex-col items-center justify-center whitespace-nowrap px-0.5 text-[13px] leading-tight font-bold text-muted no-underline outline-offset-[-3px] focus-visible:outline-2 focus-visible:outline-focus aria-[current=page]:text-brand aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-2 aria-[current=page]:after:bottom-0 aria-[current=page]:after:h-[3px] aria-[current=page]:after:rounded-full aria-[current=page]:after:bg-brand"
          >
            {label}
            {id === "tournaments" && status && (
              <span className="text-[10px] leading-tight text-brand">{status}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
