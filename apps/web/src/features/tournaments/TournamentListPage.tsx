import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { TournamentList } from "./TournamentList";

export function TournamentListPage() {
  return (
    <main className="app-theme lobby-background min-h-dvh text-ink">
      <div className={`${appPageWidthClasses} py-6`}>
        <TournamentList game="all" headingLevel="h1" />
      </div>
    </main>
  );
}
