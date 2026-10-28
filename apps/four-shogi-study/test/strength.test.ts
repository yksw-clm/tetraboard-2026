import { expect, test } from "bun:test";
import { argumentsFor, assessFormalStrength, type RecordedGame } from "../bench/strength";
import type { SinglesSample } from "../../../packages/four-shogi/bench/singlesMeasurement";
import { sides } from "@tetraboard/four-shogi";

function samples(wins: (profile: "study" | "baseline", series: number, seat: number) => boolean) {
  const games: Pick<RecordedGame, "profile" | "restricted" | "sample">[] = [];
  for (const restricted of [false, true])
    for (const profile of ["study", "baseline"] as const)
      for (let series = 0; series < 16; series++)
        for (const [index, seat] of sides.entries()) {
          const soleFirst = wins(profile, series, index);
          const sample: SinglesSample = {
            matchId: `${profile}:${restricted}:${series}:${seat}`,
            seriesId: `series:${series}`,
            startKind: "opening",
            seed: 9_410_000 + series,
            seat,
            lineup: { south: "cpu", west: "cpu", north: "cpu", east: "cpu" },
            status: "finished",
            moves: 100,
            rank: soleFirst ? 1 : 2,
            soleFirst,
            tiedFirst: false,
            noSoleWinner: false,
            termination: "last_player",
            eliminations: [],
            finalStateHash: "fixture",
            trajectoryHash: "fixture",
            decisions: [],
          };
          games.push({ profile, restricted, sample });
        }
  return games;
}

test("正式測定の予算と局数を結果取得前に固定する", () => {
  const options = argumentsFor(["--formal", "true"]);
  expect(options).toMatchObject({
    budget: { timeMs: 1000 },
    threads: 4,
    memoryMb: 8192,
    seeds: 16,
    maxPlies: 512,
  });
  expect(() => argumentsFor(["--formal", "true", "--time-ms", "5000"])).toThrow("正式測定");
  expect(() => argumentsFor(["--formal", "true", "--seeds", "2"])).toThrow("正式測定");
  expect(() => argumentsFor(["--formal", "true", "--minimum-rate", "0.1"])).toThrow("未知");
});

test("席とON/OFFがそろうまで正式棋力を判定しない", () => {
  const games = samples((profile, _series, seat) => seat < (profile === "study" ? 3 : 2));
  expect(assessFormalStrength(games).status).toBe("passed");
  expect(assessFormalStrength(games.slice(0, -1)).status).toBe("pending");
  expect(assessFormalStrength(games, false).status).toBe("invalid_source_changed");
});

test("単独率40%と系列区間下限と同時間baselineを独立に検査する", () => {
  expect(
    assessFormalStrength(samples((profile, _series, seat) => seat < (profile === "study" ? 1 : 0)))
      .status,
  ).toBe("failed");
  const clustered = assessFormalStrength(
    samples((profile, series) => profile === "study" && series < 7),
  );
  expect(clustered.byRule[0].study!.soleFirstRate).toBeGreaterThanOrEqual(0.4);
  expect(clustered.byRule[0].study!.soleFirstInterval95![0]).toBeLessThanOrEqual(0.25);
  expect(clustered.status).toBe("failed");
  expect(
    assessFormalStrength(samples((profile, _series, seat) => seat < (profile === "study" ? 2 : 3)))
      .status,
  ).toBe("failed");
});

test("未終局と同率1位を単独勝ちへ数えない", () => {
  const games = samples(() => false).map((game) => ({
    ...game,
    sample: { ...game.sample, status: "unfinished" as const, rank: null, termination: "max_plies" },
  }));
  const result = assessFormalStrength(games);
  expect(result.status).toBe("failed");
  expect(result.byRule[0].study).toMatchObject({ games: 64, unfinished: 64, soleFirstRate: 0 });
});
