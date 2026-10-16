import type { TournamentStage } from "@tetraboard/protocol";
import { tournamentStatusLabels } from "./tournamentPresentation";
export function TournamentStatus({ stage }: { stage: TournamentStage }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-0.5 text-[11px] font-bold text-brand">
      {stage === "active" && (
        <span className="relative flex size-2" aria-hidden="true">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-40 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2 rounded-full bg-brand" />
        </span>
      )}
      {tournamentStatusLabels[stage]}
    </span>
  );
}
