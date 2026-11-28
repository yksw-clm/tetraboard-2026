import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { useLayoutEffect, useRef, type MouseEvent } from "react";
import { Link, useLocation, useNavigationType } from "react-router";
import { tournamentDate } from "@tetraboard/protocol/tournament-pages";
import { AppButtonLink } from "../../shared/ui/AppButton";
import { LobbyGameTitle } from "./LobbyGameTitle";
import { lobbyTabParam } from "./useMobileLobby";
import type { MobileLobbyTournaments } from "../tournaments/useMobileLobbyTournaments";

const tabs = [
  { id: "play", label: "対局" },
  { id: "rankings", label: "ランキング" },
  { id: "posts", label: "投稿" },
  { id: "tournaments", label: "大会" },
] as const;
type LobbyTab = (typeof tabs)[number]["id"];

export function MobileLobbyHeader({
  game,
  selected,
  tournaments,
  onRules,
  onLeave,
  onTournamentLeave,
}: {
  game: GameId;
  selected: LobbyTab;
  tournaments?: Pick<MobileLobbyTournaments, "active" | "upcoming">;
  onRules: () => void;
  onLeave?: () => void;
  onTournamentLeave?: () => void;
}) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const activeLink = useRef<HTMLAnchorElement>(null);
  const nextTournament = tournaments?.upcoming[0];
  const status = tournaments?.active.length ? "開催中" : nextTournament ? "受付中" : null;

  useLayoutEffect(() => {
    if (navigationType !== "PUSH" || location.state?.lobbyTabNavigation !== true) return;
    if (document.activeElement === document.body)
      activeLink.current?.focus({ preventScroll: true });
  }, [location, navigationType]);

  const lobbyPath = gameCatalog[game].lobbyPath;
  const onLobby = location.pathname.replace(/\/$/, "") === lobbyPath;
  function select(event: MouseEvent<HTMLAnchorElement>, current: boolean, leave?: () => void) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (current) event.preventDefault();
    else leave?.();
  }

  return (
    <>
      <LobbyGameTitle game={game} onRules={onRules} />
      {nextTournament && (
        <section
          aria-label="次回の大会案内"
          className="flex min-w-0 items-center gap-2 rounded-control border border-line bg-white px-2.5 py-1.5"
        >
          <div className="min-w-0 flex-1 wrap-anywhere">
            <p className="text-sm font-bold">
              <span className="mr-1.5 inline-block rounded-full bg-surface-muted px-1.5 py-0.5 align-middle text-[11px] leading-tight whitespace-nowrap text-brand">
                受付中
              </span>
              {nextTournament.name}
            </p>
            <p className="text-xs text-muted">
              {tournamentDate(nextTournament.startsAtMs, nextTournament.endsAtMs, {
                showTimeZone: false,
              })}
            </p>
          </div>
          <AppButtonLink
            to={`/tournaments/${nextTournament.id}`}
            onClick={(event) => select(event, false, onTournamentLeave)}
            size="compact"
            className="min-h-11 px-2.5"
          >
            大会詳細
          </AppButtonLink>
        </section>
      )}
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
              onClick={(event) => select(event, current, onLeave)}
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
    </>
  );
}
