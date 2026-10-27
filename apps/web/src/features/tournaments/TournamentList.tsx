import { Link } from "react-router";
import { useRef } from "react";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppHorizontalScrollButtons } from "../../shared/ui/AppHorizontalScrollButtons";
import { TournamentStatus } from "./TournamentStatus";
import { tournamentDate } from "./tournamentPresentation";
import { useTournamentList } from "./useTournamentList";

export function TournamentList({ game }: { game: GameId | "all" }) {
  const state = useTournamentList(game);
  const list = useRef<HTMLUListElement>(null);
  const titleId = `tournament-list-${game}-title`;
  return (
    <section aria-labelledby={titleId} className="min-w-0">
      <h2 id={titleId} className="mb-4 text-xl font-bold">
        大会一覧
      </h2>
      {state.error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {state.error}
          <AppButton
            appearance="quiet"
            size="compact"
            isDisabled={state.pending !== null}
            onPress={() => void state.refresh()}
          >
            再試行
          </AppButton>
        </p>
      )}
      {!state.loaded && !state.error && (
        <p role="status" className="text-sm text-muted">
          大会一覧を読み込んでいます…
        </p>
      )}
      {state.loaded && state.tournaments.length === 0 && (
        <p className="rounded-control bg-white p-5 text-center text-sm text-muted">
          公開されている大会はありません。
        </p>
      )}
      <div className="relative isolate min-w-0">
        <ul
          ref={list}
          aria-label="大会一覧の大会"
          tabIndex={state.tournaments.length ? 0 : undefined}
          className="m-0 flex w-full min-w-0 list-none flex-col gap-3 p-0 [@media(min-width:768px)]:flex-row [@media(min-width:768px)]:flex-nowrap [@media(min-width:768px)]:overflow-x-auto [@media(min-width:768px)]:pb-1"
        >
          {state.tournaments.map((tournament) => (
            <li
              key={tournament.id}
              className="min-w-0 [@media(min-width:768px)]:shrink-0 [@media(min-width:768px)]:[width:min(320px,100%)]"
            >
              <AppCard
                role="article"
                aria-labelledby={`tournament-list-${tournament.id}-name`}
                density="compact"
                className="h-full min-w-0 gap-3 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3
                    id={`tournament-list-${tournament.id}-name`}
                    className="min-w-0 text-base font-bold break-words"
                  >
                    {tournament.name}
                  </h3>
                  <TournamentStatus stage={tournament.status} />
                </div>
                <p className="text-xs text-muted">
                  {game === "all" && <span>{gameCatalog[tournament.game].name} · </span>}
                  {tournamentDate(tournament.startsAtMs, tournament.endsAtMs, {
                    showTimeZone: false,
                  })}
                </p>
                <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
                  {tournament.status === "upcoming" && (
                    <p className="inline-flex items-baseline gap-1 text-xs text-muted">
                      <strong className="text-[30px] leading-none font-bold text-ink tabular-nums">
                        {tournament.entryCount}
                      </strong>
                      <span>人がエントリー中</span>
                    </p>
                  )}
                  {tournament.status === "finished" && (
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {tournament.winners.length > 0 ? (
                        <>
                          <p className="shrink-0 text-xs font-bold text-muted">
                            {tournament.winners.length > 1 ? "同率優勝" : "優勝"}
                          </p>
                          <ul className="m-0 flex min-w-0 list-none flex-wrap gap-x-4 gap-y-2 p-0">
                            {tournament.winners.map((winner, index) => (
                              <li key={index} className="flex min-w-0 items-center gap-2">
                                <AppAvatar src={winner.avatarUrl} className="size-7" />
                                <span className="min-w-0 text-sm font-semibold break-words">
                                  {winner.name}
                                  {winner.isGuest && (
                                    <span className="ml-1 text-xs font-normal text-muted">
                                      ゲスト
                                    </span>
                                  )}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        <p className="text-sm text-muted">表彰なし</p>
                      )}
                    </div>
                  )}
                  <Link
                    to={`/tournaments/${tournament.id}`}
                    className="ml-auto inline-flex min-h-11 shrink-0 items-center text-sm font-bold text-brand underline"
                  >
                    {tournament.status === "finished" ? "結果を見る" : "詳細へ"}
                  </Link>
                </div>
              </AppCard>
            </li>
          ))}
        </ul>
        <div className="hidden [@media(min-width:768px)]:block">
          <AppHorizontalScrollButtons
            scrollRef={list}
            label="大会一覧"
            contentKey={state.tournaments}
          />
        </div>
      </div>
      {state.nextCursor && (
        <AppButton
          appearance="secondary"
          className="mt-3 w-full"
          isDisabled={state.pending !== null}
          isPending={state.pending === "more"}
          onPress={() => void state.more()}
        >
          もっと見る
        </AppButton>
      )}
    </section>
  );
}
