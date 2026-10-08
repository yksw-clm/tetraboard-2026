import { Link } from "react-router";
import { lobbyAnnouncementSchema } from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";
import { AppCard } from "../../shared/ui/AppCard";
import { useAnnouncementData } from "../updates/useAnnouncementData";
const parse = (body: unknown) => lobbyAnnouncementSchema.parse(body);
export function LobbyAnnouncement({ game }: { game: GameId }) {
  const state = useAnnouncementData(`/api/announcements/lobby?game=${game}`, parse);
  const entry = state.data?.announcement;
  if (!entry) return null;
  return (
    <section aria-label="ロビーのお知らせ" className="min-w-0 wrap-anywhere">
      <AppCard
        density="compact"
        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0"
      >
        <h2 className="col-start-1 row-start-1 text-sm font-bold">{entry.title}</h2>
        <p className="col-span-2 row-start-2 text-xs leading-relaxed text-muted [@media(min-width:768px)]:col-span-1">
          {entry.summary}
        </p>
        <Link
          className="col-start-2 row-start-1 inline-flex min-h-11 items-center text-xs text-brand underline [@media(min-width:768px)]:row-end-3"
          to={`/updates/${entry.id}`}
        >
          お知らせへ<span className="sr-only">：{entry.title}</span>
        </Link>
      </AppCard>
    </section>
  );
}
