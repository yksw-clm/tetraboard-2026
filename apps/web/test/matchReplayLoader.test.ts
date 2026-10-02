import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { matchReplayLoader } from "../src/features/room/matchReplayLoader";
import { replayMatch } from "../browser-tests/matchReplayFixtures";

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
  context: {},
});

test("画面移動のabortを棋譜取得へ伝え、取得失敗へ変換しない", async () => {
  const controller = new AbortController();
  const input = args(replayMatch().id, controller.signal);
  fetchSpy.mockImplementation(
    (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
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
