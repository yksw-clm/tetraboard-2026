import { afterEach, expect, spyOn, test } from "bun:test";
import { fourReversiMatchDetailSchema, fourShogiMatchDetailSchema } from "@tetraboard/protocol";
import { reversiArchives, shogiArchives } from "../../../test-fixtures/matches";
import { replayFrames } from "../src/features/room/replayFrames";
import { fetchFourShogiMatchReplay } from "../src/features/room/fourShogiMatchReplay";
import firebaseReversi from "../../../test-fixtures/matches/firebase-four-reversi.json";
const fetchSpies: ReturnType<typeof spyOn>[] = [];
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
    for (const point of fixture.checkpoints) expect(frames[point.index]).toEqual(point.frame);
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
