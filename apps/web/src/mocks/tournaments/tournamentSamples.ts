export type TournamentStage = "upcoming" | "active" | "settling" | "finished";
export type MockAccount = "guest" | "member" | "entrant";
export type MockScenario = "normal" | "tied" | "empty";

export const stageLabels: Record<TournamentStage, string> = {
  upcoming: "エントリー受付中",
  active: "開催中",
  settling: "結果発表待ち",
  finished: "結果発表",
};

export const tournamentName = "第一回 TetraBoard 四人将棋大会";
export const tournamentDate = "2026年10月24日（土）20:00〜22:00";

export type Standing = {
  name: string;
  places: readonly [number, number, number, number];
  knockouts: number;
  self?: boolean;
};

// 順位表と本人欄の数値は同じサンプルから表示します。
export const sampleStandings: Standing[] = [
  { name: "てとら", places: [4, 1, 1, 0], knockouts: 9 },
  { name: "しろくま", places: [3, 2, 1, 0], knockouts: 7 },
  { name: "四人将棋が大好きです", places: [2, 2, 2, 1], knockouts: 6 },
  { name: "つばき", places: [2, 1, 1, 1], knockouts: 5 },
  { name: "もち", places: [1, 2, 1, 1], knockouts: 4 },
  { name: "銀のねこ", places: [1, 1, 2, 1], knockouts: 3 },
  { name: "そら", places: [1, 1, 1, 1], knockouts: 3 },
  { name: "こはく", places: [1, 0, 2, 1], knockouts: 2, self: true },
  { name: "ふう", places: [0, 2, 1, 1], knockouts: 2 },
  { name: "あお", places: [0, 1, 1, 1], knockouts: 1 },
  { name: "王手びより", places: [0, 0, 1, 1], knockouts: 0 },
  ...["あんず", "たぬき", "りく", "歩のこころ", "まる", "わかば", "ゆず"].map((name): Standing => ({
    name,
    places: [0, 0, 0, 0],
    knockouts: 0,
  })),
];

export function standingStats(standing: Standing) {
  const games = standing.places.reduce((total, count) => total + count, 0);
  return {
    games,
    points: standing.places[0] * 4 + standing.places[1] * 2 + standing.places[2],
    average: games
      ? (
          standing.places.reduce((total, count, index) => total + count * (index + 1), 0) / games
        ).toFixed(2)
      : "—",
  };
}
