import { gameCatalog, type GameId } from "./games";
import type { TournamentPublic } from "./tournaments";

export const tournamentListPath = "/tournaments";

export function tournamentDetailPath(id: number): string {
  return `${tournamentListPath}/${id}`;
}

export function tournamentListMetadata(origin: string) {
  return {
    title: "大会一覧｜TetraBoard",
    description:
      "TetraBoardで開催している大会の一覧です。開催中の大会、次回の大会、過去の大会の結果を見られます。",
    canonical: new URL(tournamentListPath, origin).href,
  };
}

const startDateFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "long",
  day: "numeric",
});

export type TournamentPageInfo = Pick<
  TournamentPublic,
  "id" | "name" | "startsAtMs" | "status" | "entryCount" | "finalizedAtMs"
> & { game: GameId };

export function tournamentDetailMetadata(origin: string, tournament: TournamentPageInfo) {
  const game = gameCatalog[tournament.game].name;
  const date = startDateFormatter.format(tournament.startsAtMs);
  const finished = tournament.finalizedAtMs !== null;
  const description = finished
    ? `${game}の大会の結果です。${date}に開催し、${tournament.entryCount}人がエントリーしました。`
    : tournament.status === "upcoming"
      ? `${game}の大会です。${date}に開催します。`
      : `${game}の大会です。${date}に開催し、${tournament.entryCount}人がエントリーしています。`;
  return {
    title: `${tournament.name}${finished ? " 結果" : ""}｜TetraBoard`,
    description,
    canonical: new URL(tournamentDetailPath(tournament.id), origin).href,
  };
}

const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "long",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export function tournamentDate(
  startsAtMs: number,
  endsAtMs: number,
  { showTimeZone = true }: { showTimeZone?: boolean } = {},
) {
  return `${dateFormatter.format(startsAtMs)} 〜 ${dateFormatter.format(endsAtMs)}${showTimeZone ? "〈日本時間〉" : ""}`;
}
