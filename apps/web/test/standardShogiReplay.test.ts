import { afterEach, expect, test } from "bun:test";
import { fetchShogiMatchReplay } from "../src/features/room/standardShogiMatchReplay";
import { fetchShogiReplay } from "../src/features/room/standardShogiReplay";
import { standardSavedRound } from "./fixtures/standardShogiFixtures";
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test("通常将棋のページ棋譜で全局面と4回目の千日手を再現する", async () => {
  const { match, page } = standardSavedRound();
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    urls.push(url);
    return Response.json(
      page(Number(new URL(url, "https://example.test").searchParams.get("cursor") ?? 0)),
    );
  }) as typeof fetch;
  const frames = await fetchShogiMatchReplay(match, new AbortController().signal);
  expect(frames).toHaveLength(13);
  expect(frames[0].game.board.flat().filter(Boolean)).toHaveLength(40);
  expect(frames.at(-1)?.game).toEqual(match.game);
  expect(frames.at(-1)?.game.result).toEqual({ winner: null, reason: "repetition" });
  expect(
    urls.map((url) => new URL(url, "https://example.test").searchParams.get("cursor")),
  ).toEqual([null, "5", "10"]);
  expect(frames.every((f) => !("repetitions" in f.game))).toBe(true);
});
test("通常将棋の棋譜は局識別・ページ連続性・最終状態の不一致や取消を採用しない", async () => {
  const { match, page } = standardSavedRound();
  const first = page(0);
  for (const corrupt of [
    { ...first, matchId: "00000000-0000-4000-8000-000000000030" },
    { ...first, nextCursor: 4 },
    { ...first, events: [] },
    { ...first, eventCount: 11 },
  ]) {
    globalThis.fetch = (async () => Response.json(corrupt)) as typeof fetch;
    await expect(fetchShogiMatchReplay(match, new AbortController().signal)).rejects.toThrow();
  }
  globalThis.fetch = (async (input) =>
    Response.json(
      page(Number(new URL(String(input), "https://example.test").searchParams.get("cursor") ?? 0)),
    )) as typeof fetch;
  await expect(
    fetchShogiMatchReplay(
      { ...match, game: { ...match.game, moveNumber: 13 } },
      new AbortController().signal,
    ),
  ).rejects.toThrow("final position mismatch");
  const controller = new AbortController();
  controller.abort();
  await expect(fetchShogiMatchReplay(match, controller.signal)).rejects.toThrow("Aborted");
});
test("ルーム棋譜も共有ページ取得で局面を復元し、別世代の応答を拒否する", async () => {
  const { match, page } = standardSavedRound();
  const instanceId = "00000000-0000-4000-8000-000000000010";
  globalThis.fetch = (async (input) => {
    const { matchId: _id, ...data } = page(
      Number(new URL(String(input), "https://example.test").searchParams.get("cursor") ?? 0),
    );
    return Response.json({ ...data, instanceId, roundId: match.id });
  }) as typeof fetch;
  const options = {
    roomId: match.roomId,
    instanceId,
    lastRound: {
      roundId: match.id,
      game: match.game,
      players: match.participants.map(({ id, name, side }) => ({ id, name, side })),
      eventCount: match.replay.eventCount,
    },
    signal: new AbortController().signal,
  };
  const frames = await fetchShogiReplay(options);
  expect(frames.at(-1)?.game).toEqual(match.game);
  await expect(
    fetchShogiReplay({ ...options, instanceId: "00000000-0000-4000-8000-000000000011" }),
  ).rejects.toThrow();
});
