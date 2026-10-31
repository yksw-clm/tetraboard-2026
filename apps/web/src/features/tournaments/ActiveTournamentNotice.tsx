import { AppButtonLink } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import { TournamentStatus } from "./TournamentStatus";
import { tournamentRemaining } from "./tournamentPresentation";
import { useActiveTournaments } from "./useActiveTournaments";

export function ActiveTournamentNotice() {
  const { tournaments, serverNowMs } = useActiveTournaments();
  if (!tournaments.length) return null;
  return (
    <section aria-label="開催中の大会" className="flex flex-col gap-2">
      {tournaments.map((tournament) => (
        <div
          key={tournament.id}
          className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border border-solid border-line bg-white px-4 py-3 shadow-panel"
        >
          <AppIcon name="trophy" className="text-brand [@media(max-width:400px)]:hidden" />
          <div className="min-w-0 flex-1 basis-40">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold break-words">{tournament.name}</h2>
              <TournamentStatus stage="active" />
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {tournamentRemaining(tournament, serverNowMs)}
            </p>
          </div>
          <AppButtonLink
            to={`/tournaments/${tournament.id}`}
            appearance="secondary"
            size="compact"
            className="min-h-11"
          >
            大会詳細
            <AppIcon name="arrow" className="size-4" />
          </AppButtonLink>
        </div>
      ))}
    </section>
  );
}
