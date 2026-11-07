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
export function tournamentDate(
  startsAtMs: number,
  endsAtMs: number,
  { showTimeZone = true }: { showTimeZone?: boolean } = {},
) {
  return `${dateFormatter.format(startsAtMs)} 〜 ${dateFormatter.format(endsAtMs)}${showTimeZone ? "〈日本時間〉" : ""}`;
}

const listDateOptions: Intl.DateTimeFormatOptions = {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  weekday: "short",
};
const listDateFormatter = new Intl.DateTimeFormat("ja-JP", listDateOptions);
const listYearDateFormatter = new Intl.DateTimeFormat("ja-JP", {
  ...listDateOptions,
  year: "numeric",
});
const yearFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
});
const timeFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function tournamentListDate(startsAtMs: number, endsAtMs: number, now = Date.now()) {
  const currentYear = yearFormatter.format(now);
  const formatter =
    yearFormatter.format(startsAtMs) === currentYear &&
    yearFormatter.format(endsAtMs) === currentYear
      ? listDateFormatter
      : listYearDateFormatter;
  const startDate = formatter.format(startsAtMs);
  const endDate = formatter.format(endsAtMs);
  return `${startDate} ${timeFormatter.format(startsAtMs)}〜${startDate === endDate ? "" : `${endDate} `}${timeFormatter.format(endsAtMs)}`;
}

export function tournamentRemaining(tournament: TournamentPublic, now = Date.now()) {
  const minutes = Math.max(0, Math.ceil((tournament.endsAtMs - now) / 60_000));
  const remaining =
    minutes < 60
      ? `${minutes}分`
      : `${Math.floor(minutes / 60)}時間${String(minutes % 60).padStart(2, "0")}分`;
  return `終了まであと${remaining}`;
}
export function tournamentPoints(units: number) {
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(units / 12);
}
