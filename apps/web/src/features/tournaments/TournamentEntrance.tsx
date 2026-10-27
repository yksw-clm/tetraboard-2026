import type { TournamentPublic } from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import { useAccount } from "../account/useAccount";
import { TournamentStatus } from "./TournamentStatus";
import { tournamentDate, tournamentRemaining } from "./tournamentPresentation";
import { useLobbyTournaments } from "./useLobbyTournaments";

function TournamentEntranceCard({
  tournament,
  entered,
  entryDisabled,
  guest,
  error,
  onRetry,
  serverTimeMs,
}: {
  tournament: TournamentPublic;
  entered: boolean;
  entryDisabled: boolean;
  guest: boolean;
  error: string | null;
  onRetry: () => void;
  serverTimeMs: number;
}) {
  const ended = tournament.status === "settling" || tournament.status === "finished";
  const entryLabel = entered
    ? tournament.status === "upcoming"
      ? "エントリー済み"
      : "大会に参加"
    : guest
      ? "ゲストでエントリー"
      : "エントリー";
  return (
    <AppCard
      role="article"
      aria-labelledby={`tournament-${tournament.id}-entrance-title`}
      density="compact"
      className="flex flex-row flex-wrap items-center justify-between gap-x-5 gap-y-3"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="hidden size-10 shrink-0 place-items-center rounded-control bg-surface-muted text-brand sm:grid">
          <AppIcon name="crown" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 id={`tournament-${tournament.id}-entrance-title`} className="text-sm font-bold">
              {tournament.name}
            </h3>
            <TournamentStatus stage={tournament.status} />
          </div>
          <p className="text-xs text-muted">
            {tournament.status === "finished"
              ? "大会の結果を公開しています。"
              : tournament.status === "settling"
                ? "対局と結果の保存を待っています。順位は暫定です。"
                : tournament.status === "active"
                  ? tournamentRemaining(tournament, serverTimeMs)
                  : tournamentDate(tournament.startsAtMs, tournament.endsAtMs, {
                      showTimeZone: false,
                    })}
          </p>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
              <AppButton appearance="quiet" size="compact" onPress={onRetry}>
                再試行
              </AppButton>
            </p>
          )}
        </div>
      </div>
      <div className="flex w-full flex-wrap items-center justify-end gap-x-4 gap-y-2 sm:w-auto">
        <p className="inline-flex items-baseline gap-1 text-xs text-muted">
          <strong className="text-[30px] leading-none font-bold text-ink tabular-nums">
            {tournament.entryCount}
          </strong>
          <span>{tournament.status === "active" ? "人が参加中" : "人がエントリー中"}</span>
        </p>
        <AppButtonLink to={`/tournaments/${tournament.id}`} size="compact" className="min-h-11">
          {tournament.status === "finished" ? "結果を見る" : "詳細へ"}
        </AppButtonLink>
        {!ended &&
          (entryDisabled || (entered && tournament.status === "upcoming") ? (
            <AppButton isDisabled appearance="secondary" size="compact">
              {entryLabel}
            </AppButton>
          ) : (
            <AppButtonLink
              to={`/tournaments/${tournament.id}`}
              state={entered ? undefined : { tournamentEntryRequested: true }}
              size="compact"
              className="min-h-11 whitespace-normal text-center"
            >
              {entryLabel}
            </AppButtonLink>
          ))}
      </div>
    </AppCard>
  );
}

export function TournamentEntrance({ game = "four-shogi" }: { game?: GameId }) {
  const account = useAccount();
  const state = useLobbyTournaments(game);
  if (!state.current.length && !state.upcoming.length && !state.error) return null;
  return (
    <div className="space-y-4">
      {state.error && (
        <p role="alert" className="text-xs text-danger">
          {state.error}
          <AppButton appearance="quiet" size="compact" onPress={state.retry}>
            再試行
          </AppButton>
        </p>
      )}
      {(
        [
          { id: "current", title: "大会", tournaments: state.current },
          { id: "upcoming", title: "次回の大会", tournaments: state.upcoming },
        ] as const
      )
        .filter(({ tournaments }) => tournaments.length)
        .map(({ id, title, tournaments }) => (
          <section
            key={id}
            aria-labelledby={`${game}-${id}-tournaments-title`}
            className="space-y-2"
          >
            <h2 id={`${game}-${id}-tournaments-title`} className="text-lg font-bold">
              {title}
            </h2>
            {tournaments.map((tournament) => {
              const participation = state.participation(tournament.id);
              return (
                <TournamentEntranceCard
                  key={tournament.id}
                  tournament={tournament}
                  entered={participation.entered}
                  entryDisabled={state.authUnavailable || !participation.ready}
                  guest={!account.user}
                  error={participation.error}
                  onRetry={state.retry}
                  serverTimeMs={state.serverTimeMs}
                />
              );
            })}
          </section>
        ))}
    </div>
  );
}
