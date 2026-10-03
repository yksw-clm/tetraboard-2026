import { afterEach, expect, test } from "bun:test";
import {
  applyAction,
  createInitialState,
  eliminateSide,
  type FourShogiState,
} from "@tetraboard/four-shogi";
import {
  fourShogiMatchDetailSchema,
  fourShogiPublicStateSchema,
  type MatchReplayPage,
} from "@tetraboard/protocol";
import { fetchFourShogiMatchReplay } from "../src/features/room/fourShogiMatchReplay";
import { matchResultGroups } from "../src/features/account/matchSummaryPresentation";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const ids = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const sides = ["south", "west", "north", "east"] as const;

function savedRound() {
  const initial = {
    mode: "singles" as const,
    players: Object.fromEntries(sides.map((side, i) => [side, ids[i]!])) as Record<
      (typeof sides)[number],
      string
    >,
    threePlayerAttackProhibited: true,
  };
  let state: FourShogiState = createInitialState(initial);
  const events: MatchReplayPage["events"] = [];
  const action = {
    type: "movePiece" as const,
    from: { x: 4, y: 6 },
    to: { x: 4, y: 5 },
    promote: false,
  };
  const moved = applyAction(state, "south", action);
  if (!moved.ok) throw new Error("Invalid fixed move");
  events.push({ index: 0, event: { type: "action", side: "south", action } });
  state = moved.state;
  for (const side of ["west", "north", "east"] as const) {
    const result = eliminateSide(state, side, "left");
    if (!result.ok) throw new Error("Invalid fixed elimination");
    events.push({ index: events.length, event: { type: "eliminate", side, reason: "left" } });
    state = result.state;
  }
  const { repetitions: _repetitions, ...publicState } = state;
  const match = fourShogiMatchDetailSchema.parse({
    id: "00000000-0000-4000-8000-000000000020",
    roomId: "12345",
    startedAtMs: 100,
    endedAtMs: 200,
    settings: {
      game: "four-shogi",
      mode: "singles",
      timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
      threePlayerAttackProhibited: true,
    },
    participants: sides.map((side, seat) => ({
      id: ids[seat]!,
      side,
      seat,
      name: side,
      kind: "human",
      avatarUrl: null,
    })),
    selfPlayerId: ids[2],
    game: fourShogiPublicStateSchema.parse(publicState),
    knockouts: { south: 0, west: 0, north: 0, east: 0 },
    replay: { rulesVersion: 1, initial, eventCount: events.length },
  });
  const page = (offset: number): MatchReplayPage => ({
    matchId: match.id,
    rulesVersion: 1,
    initial,
    eventCount: events.length,
    events: events.slice(offset, offset + 2),
    nextCursor: offset + 2 < events.length ? offset + 2 : null,
  });
  return { match, page };
}

test("保存棋譜の分割取得から開始・着手・各脱落を復元し、ルーム通信を使わない", async () => {
  const round = savedRound();
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    return Response.json(
      round.page(Number(new URL(url, "https://example.test").searchParams.get("cursor") ?? 0)),
    );
  }) as typeof fetch;
  const frames = await fetchFourShogiMatchReplay(round.match, new AbortController().signal);
  expect(requests).toEqual([
    `/api/account/matches/${round.match.id}/replay`,
    `/api/account/matches/${round.match.id}/replay?cursor=2`,
  ]);
  expect(frames).toHaveLength(5);
  expect(frames[0]!.label).toBe("開始局面");
  expect(frames[0]!.game.board[6]![4]?.kind).toBe("pawn");
  expect(frames[1]!.game.board[6]![4]).toBeNull();
  expect(frames[1]!.game.board[5]![4]?.side).toBe("south");
  expect(frames[1]!.game.eliminations).toEqual([]);
  expect(frames[2]!.label).toBe("西 退室");
  expect(frames.at(-1)!.game).toEqual(round.match.game);
  expect(frames.every((frame) => !("repetitions" in frame.game))).toBe(true);
});

test("保存棋譜はページ識別・連続性・終局結果の不一致や取消を採用しない", async () => {
  const round = savedRound();
  const corruptions: ((page: MatchReplayPage) => MatchReplayPage)[] = [
    (page) => ({ ...page, matchId: ids[0]! }),
    (page) => ({ ...page, eventCount: 5 }),
    (page) => ({ ...page, initial: { ...page.initial, threePlayerAttackProhibited: false } }),
    (page) => ({ ...page, events: [{ ...page.events[0]!, index: 3 }, page.events[1]!] }),
    (page) => ({ ...page, nextCursor: 3 }),
    (page) => ({ ...page, nextCursor: null }),
    (page) => ({ ...page, events: [] }),
  ];
  for (const corrupt of corruptions) {
    globalThis.fetch = (async () => Response.json(corrupt(round.page(0)))) as typeof fetch;
    await expect(
      fetchFourShogiMatchReplay(round.match, new AbortController().signal),
    ).rejects.toThrow();
  }
  globalThis.fetch = (async (input) =>
    Response.json(
      round.page(
        Number(new URL(String(input), "https://example.test").searchParams.get("cursor") ?? 0),
      ),
    )) as typeof fetch;
  await expect(
    fetchFourShogiMatchReplay(
      { ...round.match, game: { ...round.match.game, moveNumber: 2 } },
      new AbortController().signal,
    ),
  ).rejects.toThrow("final position mismatch");
  const controller = new AbortController();
  controller.abort();
  await expect(fetchFourShogiMatchReplay(round.match, controller.signal)).rejects.toThrow(
    "Aborted",
  );
});

test("将棋履歴は同順位を方向順に並べ、ダブルスは勝利チームを先に表示する", () => {
  const { match } = savedRound();
  const singles = matchResultGroups({
    id: match.id,
    game: "four-shogi",
    mode: "singles",
    startedAtMs: 100,
    endedAtMs: 200,
    participants: match.participants,
    result: {
      mode: "singles",
      reason: "repetition",
      standings: [
        { side: "north", rank: 1 },
        { side: "south", rank: 1 },
        { side: "east", rank: 3 },
        { side: "west", rank: 3 },
      ],
    },
  });
  expect(singles.map((group) => [group.label, group.players[0]!.name])).toEqual([
    ["優勝", "south"],
    ["優勝", "north"],
    ["3位", "west"],
    ["3位", "east"],
  ]);
  const doubles = matchResultGroups({
    id: match.id,
    game: "four-shogi",
    mode: "doubles",
    startedAtMs: 100,
    endedAtMs: 200,
    participants: match.participants,
    result: { mode: "doubles", reason: "team_eliminated", winner: "west-east" },
  });
  expect(doubles.map((group) => [group.label, group.players.map((player) => player.name)])).toEqual(
    [
      ["勝利", ["west", "east"]],
      ["敗北", ["south", "north"]],
    ],
  );
});
