import { afterEach, expect, spyOn, test } from "bun:test";
import { fourReversiMatchDetailSchema, fourShogiMatchDetailSchema } from "@tetraboard/protocol";
import { reversiArchives, shogiArchives } from "../../../test-fixtures/matches";
import { replayFrames } from "../src/features/room/replayFrames";
import { fetchFourShogiMatchReplay } from "../src/features/room/fourShogiMatchReplay";
import firebaseReversi from "../../../test-fixtures/matches/firebase-four-reversi.json";
const fetchSpies: ReturnType<typeof spyOn>[] = [];
const singlesLabels = [
  "開始局面",
  "30: 西7七歩打",
  "35: 南2三金打",
  "38: 東7三飛打",
  "47: 南6二銀打",
  "52: 西5五金",
  "57: 北2一金打",
  "62: 東同飛成",
  "65: 北4九銀打",
  "66: 東1六金打",
  "79: 南8二歩打",
  "80: 西8一歩打",
  "86: 南7八銀打",
  "96: 南4二銀成",
  "98: 東3五歩打",
  "99: 南5四歩打",
  "100: 西2九歩打",
  "南 退室",
];
const drawLabels = [
  "開始局面",
  "南 引分提案",
  "西 引分提案",
  "2: 西8二銀",
  "北 引分提案",
  "東 引分提案",
];
const notationLabels: Record<string, readonly string[]> = {
  "shogi-singles": singlesLabels,
  "shogi-legacy": singlesLabels,
  "shogi-doubles": ["開始局面", "1: 南5六歩", "西 退室"],
  "shogi-singles-draw": drawLabels,
  "shogi-doubles-draw": drawLabels,
};
test("Firebase版の初期配置と各手を保存局面から復元する", () => {
  const match = fourReversiMatchDetailSchema.parse(firebaseReversi.detail);
  const frames = replayFrames({ game: match.game, players: [], replay: match.replay });
  expect(match.settings.timeControl).toBeNull();
  expect(frames).toHaveLength(59);
  for (const point of firebaseReversi.checkpoints)
    expect(frames.findLast((frame) => frame.game.moveNumber === point.index)?.game.board).toEqual(
      point.board,
    );
});
afterEach(() => {
  for (const spy of fetchSpies.splice(0)) spy.mockRestore();
});
for (const fixture of reversiArchives) {
  test(`${fixture.name}: 保存局面の初期・途中・終局とパスを固定する`, () => {
    const match = fourReversiMatchDetailSchema.parse(fixture.detail);
    const before = JSON.stringify(fixture);
    const frames = replayFrames({ game: match.game, players: [], replay: match.replay });
    expect(frames.length).toBe(fixture.frameCount);
    for (const point of fixture.checkpoints) expect(frames[point.index]).toEqual(point.frame);
    expect(JSON.stringify(fixture)).toBe(before);
  });
}
for (const fixture of shogiArchives) {
  test(`${fixture.name}: rulesVersion 1の初期・途中・終局を固定する`, async () => {
    const match = fourShogiMatchDetailSchema.parse(fixture.detail);
    const before = JSON.stringify(fixture);
    fetchSpies.push(
      spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = new URL(String(input), "https://example.test");
        expect(url.pathname).toBe(`/api/account/matches/${match.id}/replay`);
        const cursor = Number(url.searchParams.get("cursor") ?? 0);
        return Response.json({
          matchId: match.id,
          ...match.replay,
          events: fixture.events.slice(cursor, cursor + 100),
          nextCursor: cursor + 100 < fixture.events.length ? cursor + 100 : null,
        });
      }),
    );
    const frames = await fetchFourShogiMatchReplay(match, new AbortController().signal);
    expect(frames.length).toBe(fixture.frameCount);
    expect(fixture.checkpoints.map((point) => frames[point.index]!.label)).toEqual(
      notationLabels[fixture.name],
    );
    for (const point of fixture.checkpoints) {
      const {
        event,
        eliminatedHands: _hands,
        label: _label,
        accessibleLabel: _accessible,
        ...frame
      } = frames[point.index]!;
      const { label: _oldLabel, ...expected } = point.frame;
      expect(frame).toEqual(expected);
      expect(event).toEqual(fixture.events[point.index - 1]?.event);
    }
    const retained: Record<string, unknown> = {};
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index]!;
      if (index > 0) {
        const prior = frames[index - 1]!.game;
        for (const entry of frame.game.eliminations) {
          if (!prior.eliminations.some((old) => old.side === entry.side))
            retained[entry.side] = prior.hands[entry.side];
        }
      }
      expect(frame.eliminatedHands).toEqual(retained);
    }
    expect(JSON.stringify(fixture)).toBe(before);
  });
}

for (const corruption of ["rulesVersion", "eventIndex", "finalPosition"] as const) {
  test(`保存棋譜の${corruption}不整合では未完成フレームを返さない`, async () => {
    const fixture = shogiArchives[0];
    const match = fourShogiMatchDetailSchema.parse(fixture.detail);
    if (corruption === "finalPosition") match.game.moveNumber++;
    fetchSpies.push(
      spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const cursor = Number(
          new URL(String(input), "https://example.test").searchParams.get("cursor") ?? 0,
        );
        const events = structuredClone(fixture.events.slice(cursor, cursor + 100));
        if (corruption === "eventIndex" && events[0]) events[0].index++;
        return Response.json({
          matchId: match.id,
          ...match.replay,
          rulesVersion: corruption === "rulesVersion" ? 2 : 1,
          events,
          nextCursor: cursor + 100 < fixture.events.length ? cursor + 100 : null,
        });
      }),
    );
    await expect(fetchFourShogiMatchReplay(match, new AbortController().signal)).rejects.toThrow();
  });
}
