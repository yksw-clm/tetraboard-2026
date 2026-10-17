import type { TournamentPublic } from "@tetraboard/protocol";

export const tournamentStatusLabels = {
  upcoming: "エントリー受付中",
  active: "開催中",
  settling: "結果発表待ち",
  finished: "結果発表",
};
const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "long",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export function tournamentDate(startsAtMs: number, endsAtMs: number) {
  return `${dateFormatter.format(startsAtMs)} 〜 ${dateFormatter.format(endsAtMs)}〈日本時間〉`;
}
export function tournamentRemaining(tournament: TournamentPublic, now = Date.now()) {
  return `終了まであと${Math.max(0, Math.ceil((tournament.endsAtMs - now) / 60_000))}分`;
}
export function tournamentPoints(units: number) {
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(units / 12);
}
