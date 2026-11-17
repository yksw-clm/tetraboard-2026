import { expect, test } from "bun:test";
import {
  prepareTournamentMatch,
  tournamentMatchPoints,
  type TournamentMatchRecord,
  type TournamentPublication,
  type TournamentPoints,
} from "../src";
import { context, match, policy, settings } from "./fixtures";
import type { Write } from "./memoryPorts";

test("検証した参加者の順で得点4件と保存済み更新を返し、呼び出し時には実行しない", () => {
  const applied: (TournamentPoints | string)[] = [];
  const store: TournamentPublication<Write> = {
    points: (_context, _record, _game, points) => () => {
      applied.push(points);
    },
    saved: (_context, _record, now) => () => {
      applied.push(`saved:${now}`);
    },
  };
  const writes = prepareTournamentMatch(store, context, match(), policy, () => 4000);
  expect(writes).toHaveLength(5);
  expect(applied).toEqual([]);
  writes.forEach((write) => write());
  expect(applied).toEqual([
    { playerId: "player-0", rank: 1, knockouts: 2, units: 48 },
    { playerId: "player-1", rank: 2, knockouts: 1, units: 24 },
    { playerId: "player-2", rank: 3, knockouts: 0, units: 12 },
    { playerId: "player-3", rank: 4, knockouts: 0, units: 0 },
    "saved:4000",
  ]);
});

test("終了時刻を過ぎて終局した対象局と、4人同順位の勝ち点を扱う", () => {
  const record = match();
  if (record.game.result?.mode !== "singles") throw Error("fixture");
  record.game.result.standings.forEach((standing) => {
    standing.rank = 1;
  });
  expect(tournamentMatchPoints(context, record, policy).points.map((p) => p.units)).toEqual([
    21, 21, 21, 21,
  ]);
  const nonShogi: TournamentMatchRecord = {
    ...match(),
    settings: { game: "four-reversi", mode: "singles", timeControl: settings.timeControl },
    participants: ["black", "white", "red", "blue"].map((color, i) => ({
      color,
      kind: "human",
      id: `p${i}`,
    })),
    game: {
      result: {
        mode: "singles",
        standings: ["black", "white", "red", "blue"].map((color, i) => ({ color, rank: i + 1 })),
      },
    },
  };
  const definition = {
    ...context,
    ruleVersion: 2 as const,
    settings: nonShogi.settings as typeof settings,
  };
  expect(
    tournamentMatchPoints(definition, nonShogi, policy).points.map((p) => p.knockouts),
  ).toEqual([0, 0, 0, 0]);
});

const invalid: [string, (record: TournamentMatchRecord) => void, string][] = [
  [
    "別局",
    (r) => {
      r.id = "another";
    },
    "Invalid tournament result",
  ],
  [
    "設定差",
    (r) => {
      r.settings = { ...settings, threePlayerAttackProhibited: false };
    },
    "Invalid tournament result",
  ],
  [
    "ダブルス",
    (r) => {
      r.game.result = { mode: "doubles" };
    },
    "Invalid tournament result",
  ],
  [
    "未終局",
    (r) => {
      r.game.result = null;
    },
    "Invalid tournament result",
  ],
  [
    "3人",
    (r) => {
      r.participants.pop();
    },
    "Invalid tournament result",
  ],
  [
    "CPU",
    (r) => {
      r.participants[0]!.kind = "cpu";
    },
    "Invalid tournament result",
  ],
  [
    "開始前",
    (r) => {
      r.startedAtMs = 999;
    },
    "Invalid tournament result",
  ],
  [
    "終了一致",
    (r) => {
      r.startedAtMs = 2000;
    },
    "Invalid tournament result",
  ],
  [
    "順位欠落",
    (r) => {
      if (r.game.result?.mode === "singles") r.game.result.standings.pop();
    },
    "Missing tournament rank",
  ],
];
for (const [name, change, message] of invalid)
  test(`${name}の結果を拒否する`, () => {
    const record = match();
    change(record);
    expect(() => tournamentMatchPoints(context, record, policy)).toThrow(message);
  });
