import { afterEach, expect, spyOn, test } from "bun:test";
import {
  publicFourReversiMatchDetailSchema,
  publicFourShogiMatchDetailSchema,
  fourReversiMatchDetailSchema,
  getPublicMatchContract,
  type MatchSummary,
} from "@tetraboard/protocol";
import { reversiArchives, shogiArchives } from "../../../test-fixtures/matches";
import { publicMatchReplayLoader } from "../src/features/room/matchReplayLoader";
import { fetchRecentMatches } from "../src/features/matches/recentMatchesApi";
import { matchSeats } from "../src/features/room/roomPresentation";
import { shogiMatchViewerSide } from "../src/features/room/fourShogiRoomPresentation";
import { replayFrames } from "../src/features/room/replayFrames";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
function fetchSpy() {
  const spy = spyOn(globalThis, "fetch");
  spies.push(spy);
  return spy;
}
function publicReversi() {
  const { selfPlayerId: _self, ...match } = reversiArchives[0].detail;
  return publicFourReversiMatchDetailSchema.parse(match);
}
function publicShogi() {
  const { selfPlayerId: _self, ...match } = shogiArchives[0].detail;
  return publicFourShogiMatchDetailSchema.parse(match);
}
const args = (id: string, signal?: AbortSignal) => ({
  params: { matchId: id },
  request: new Request(`https://example.test/matches/${id}`, { signal }),
  context: {},
});

test("公開リバーシは本人IDを持たず黒を手前にし、保存済みの最終局面を再現する", async () => {
  const match = publicReversi();
  fetchSpy().mockResolvedValue(Response.json({ match }));
  const data = await publicMatchReplayLoader(args(match.id));
  expect(data.game).toBe("four-reversi");
  expect(data.match).not.toHaveProperty("selfPlayerId");
  expect(matchSeats(match).map((player) => player.color)).toEqual([
    "black",
    "white",
    "red",
    "blue",
  ]);
  expect(
    replayFrames({ game: match.game, replay: match.replay, players: match.participants }).at(-1)
      ?.game,
  ).toEqual(match.game);
  expect(fourReversiMatchDetailSchema.safeParse(match).success).toBe(false);
  expect(
    getPublicMatchContract.response.safeParse({ match: reversiArchives[0].detail }).success,
  ).toBe(false);
});

test("公開将棋は南を手前にし、公開エンドポイントから連番イベントを再生する", async () => {
  const match = publicShogi();
  const fixture = shogiArchives[0];
  const paths: string[] = [];
  fetchSpy().mockImplementation(async (input) => {
    const url = new URL(String(input), "https://example.test");
    paths.push(url.pathname);
    if (!url.pathname.endsWith("/replay")) return Response.json({ match });
    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    return Response.json({
      matchId: match.id,
      ...match.replay,
      events: fixture.events.slice(cursor, cursor + 100),
      nextCursor: cursor + 100 < fixture.events.length ? cursor + 100 : null,
    });
  });
  const data = await publicMatchReplayLoader(args(match.id));
  expect(data.game).toBe("four-shogi");
  if (data.game !== "four-shogi") throw new Error("Wrong replay game");
  expect(data.frames.at(-1)?.game).toEqual(match.game);
  expect(data.match).not.toHaveProperty("selfPlayerId");
  expect(shogiMatchViewerSide(match)).toBe("south");
  expect(
    shogiMatchViewerSide({
      ...match,
      selfPlayerId: match.participants.find((p) => p.side === "east")!.id,
    }),
  ).toBe("east");
  expect(paths[0]).toBe(`/api/matches/${match.id}`);
  expect(paths.slice(1).every((path) => path === `/api/matches/${match.id}/replay`)).toBe(true);
});

test("公開棋譜の不正ID・HTTP失敗・不正な詳細を表示せず、ログインへ転送しない", async () => {
  const spy = fetchSpy();
  await expect(publicMatchReplayLoader(args("bad"))).rejects.toMatchObject({ status: 400 });
  expect(spy).not.toHaveBeenCalled();
  for (const status of [400, 401, 404, 503]) {
    spy.mockResolvedValue(new Response(null, { status }));
    await expect(publicMatchReplayLoader(args(publicReversi().id))).rejects.toMatchObject({
      status,
    });
  }
  spy.mockResolvedValue(Response.json({ match: {} }));
  await expect(publicMatchReplayLoader(args(publicReversi().id))).rejects.toMatchObject({
    status: 503,
  });
});

test("公開将棋の連番や最終局面が一致しない場合は未完成棋譜を返さない", async () => {
  const match = publicShogi();
  const spy = fetchSpy();
  for (const corruption of ["index", "final"] as const) {
    spy.mockImplementation(async (input) => {
      if (!String(input).includes("/replay"))
        return Response.json({
          match:
            corruption === "final"
              ? { ...match, game: { ...match.game, moveNumber: match.game.moveNumber + 1 } }
              : match,
        });
      const cursor = Number(
        new URL(String(input), "https://example.test").searchParams.get("cursor") ?? 0,
      );
      const events = structuredClone(shogiArchives[0].events.slice(cursor, cursor + 100));
      if (corruption === "index" && events[0]) events[0].index++;
      return Response.json({
        matchId: match.id,
        ...match.replay,
        events,
        nextCursor: cursor + 100 < match.replay.eventCount ? cursor + 100 : null,
      });
    });
    await expect(publicMatchReplayLoader(args(match.id))).rejects.toMatchObject({ status: 503 });
  }
});

test("公開棋譜の画面移動では取得を中止し、失敗画面に置き換えない", async () => {
  const controller = new AbortController();
  fetchSpy().mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
  const pending = publicMatchReplayLoader(args(publicReversi().id, controller.signal));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("最近の対局は指定ゲームで取得し、別ゲームや不正応答を採用しない", async () => {
  const match = publicReversi();
  const summary: MatchSummary = {
    id: match.id,
    game: "four-reversi",
    mode: match.settings.mode,
    startedAtMs: match.startedAtMs,
    endedAtMs: match.endedAtMs,
    participants: match.participants,
    result: match.game.result,
  };
  const spy = fetchSpy().mockResolvedValue(Response.json({ matches: [summary] }));
  const signal = new AbortController().signal;
  expect(await fetchRecentMatches("four-reversi", signal)).toEqual([summary]);
  expect(spy).toHaveBeenCalledWith("/api/matches?game=four-reversi", { cache: "no-store", signal });
  spy.mockResolvedValue(Response.json({ matches: [summary] }));
  await expect(fetchRecentMatches("four-shogi", signal)).rejects.toThrow("game mismatch");
  spy.mockResolvedValue(Response.json({ matches: [] }));
  expect(await fetchRecentMatches("four-shogi", signal)).toEqual([]);
  spy.mockResolvedValue(Response.json({ matches: Array(21).fill(summary) }));
  await expect(fetchRecentMatches("four-reversi", signal)).rejects.toThrow();
  spy.mockResolvedValue(new Response(null, { status: 503 }));
  await expect(fetchRecentMatches("four-reversi", signal)).rejects.toThrow("request failed");
});
