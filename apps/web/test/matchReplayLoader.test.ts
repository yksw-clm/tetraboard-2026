import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { matchReplayLoader, publicMatchReplayLoader } from "../src/features/room/matchReplayLoader";
import { replayMatch } from "./fixtures/matchReplayFixtures";
import { shogiReplayMatch } from "./fixtures/fourShogiRecordFixtures";
import { RouterContextProvider } from "react-router";

function setupFetchSpy() {
  return spyOn(globalThis, "fetch");
}
let fetchSpy: ReturnType<typeof setupFetchSpy>;
beforeEach(() => {
  fetchSpy = setupFetchSpy();
});
afterEach(() => fetchSpy.mockRestore());
const args = (matchId: string, signal?: AbortSignal) => ({
  params: { matchId },
  request: new Request(`http://localhost/account/matches/${matchId}`, { signal }),
  context: new RouterContextProvider(),
  url: new URL(`http://localhost/account/matches/${matchId}`),
  pattern: "/account/matches/:matchId",
});

test("画面移動のabortを棋譜取得へ伝え、取得失敗へ変換しない", async () => {
  const controller = new AbortController();
  const input = args(replayMatch().id, controller.signal);
  fetchSpy.mockImplementation(
    Object.assign(
      (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      { preconnect() {} },
    ),
  );
  const pending = matchReplayLoader(input);
  expect(fetchSpy).toHaveBeenCalledWith(`/api/account/matches/${input.params.matchId}`, {
    credentials: "include",
    signal: input.request.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("不正なURLは取得せず拒否し、不正な応答を棋譜として表示しない", async () => {
  await expect(matchReplayLoader(args("bad"))).rejects.toMatchObject({ status: 400 });
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({ match: {} }), { status: 200 }));
  await expect(matchReplayLoader(args(replayMatch().id))).rejects.toMatchObject({ status: 503 });
});

test("リバーシは棋譜詳細だけを取得し、公開APIと本人APIを分ける", async () => {
  const match = replayMatch();
  fetchSpy.mockResolvedValue(Response.json({ match }));
  expect(await matchReplayLoader(args(match.id))).toEqual({ game: "four-reversi", match });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const publicMatch = { ...match };
  Reflect.deleteProperty(publicMatch, "selfPlayerId");
  fetchSpy.mockResolvedValue(Response.json({ match: publicMatch }));
  expect(await publicMatchReplayLoader(args(match.id))).toEqual({
    game: "four-reversi",
    match: publicMatch,
  });
  expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
    `/api/account/matches/${match.id}`,
    `/api/matches/${match.id}`,
  ]);
});

test("未認証は再確認用401として返し、URL・非公開・取得障害のstatusを維持する", async () => {
  for (const status of [400, 401, 404, 503]) {
    fetchSpy.mockResolvedValue(new Response(null, { status }));
    try {
      await matchReplayLoader(args(replayMatch().id));
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(status);
      if (status === 401) expect((error as Response).headers.get("Location")).toBeNull();
    }
  }
  await expect(publicMatchReplayLoader(args(replayMatch().id))).rejects.toMatchObject({
    status: 503,
  });
  fetchSpy.mockRejectedValue(new Error("network"));
  await expect(matchReplayLoader(args(replayMatch().id))).rejects.toMatchObject({ status: 503 });
});

test("将棋の100件ページ境界を復元し、途中の認証失効は再確認用401として返す", async () => {
  const fixture = shogiReplayMatch();
  fetchSpy
    .mockResolvedValueOnce(Response.json({ match: fixture.detail }))
    .mockResolvedValueOnce(Response.json(fixture.page(0)))
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(matchReplayLoader(args(fixture.detail.id))).rejects.toMatchObject({ status: 401 });
  expect(fetchSpy.mock.calls.at(-1)?.[0]).toBe(
    `/api/account/matches/${fixture.detail.id}/replay?cursor=100`,
  );
  fetchSpy.mockClear();
  fetchSpy
    .mockResolvedValueOnce(Response.json({ match: fixture.detail }))
    .mockResolvedValueOnce(Response.json(fixture.page(0)))
    .mockResolvedValueOnce(Response.json(fixture.page(100)));
  const loaded = await matchReplayLoader(args(fixture.detail.id));
  expect(loaded.game).toBe("four-shogi");
  if (loaded.game !== "four-shogi") throw new Error("dispatch");
  expect(loaded.frames).toHaveLength(fixture.events.length + 1);
  expect(loaded.frames.at(-1)?.game).toEqual(fixture.detail.game);
});
