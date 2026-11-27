import type { BoardLink } from "@tetraboard/protocol/board";
import { gameCatalog } from "@tetraboard/protocol/games";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { formatMatchDate } from "../matches/matchDatePresentation";
import { useBoardMedia, useBoardMediaItem } from "./boardMedia";

function Card({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="relative z-10 w-fit max-w-full rounded-control border border-solid border-line bg-surface-muted px-3 py-2 text-sm text-brand hover:underline"
    >
      {children}
    </Link>
  );
}

function MatchCard({ id, to }: { id: string; to: string }) {
  const { match } = useBoardMedia();
  const result = useBoardMediaItem(id, match);
  if (result.status !== "ready") return null;
  const { settings, startedAtMs } = result.data;
  return (
    <Card to={to}>
      <span className="font-semibold">{gameCatalog[settings.game].name}</span>{" "}
      <time>{formatMatchDate(startedAtMs)}</time>
    </Card>
  );
}

function TournamentCard({ id, to }: { id: number; to: string }) {
  const { tournament } = useBoardMedia();
  const result = useBoardMediaItem(id, tournament);
  return result.status === "ready" ? <Card to={to}>{result.data}</Card> : null;
}

export function BoardLinkCard({
  link,
  to,
  nearby,
}: {
  link: BoardLink;
  to: string;
  nearby: boolean;
}) {
  switch (link.kind) {
    case "match":
      return nearby ? <MatchCard id={link.matchId} to={to} /> : null;
    case "tournament":
      return nearby ? <TournamentCard id={link.tournamentId} to={to} /> : null;
    case "room":
      return <Card to={to}>ルーム {link.roomId}</Card>;
  }
}
