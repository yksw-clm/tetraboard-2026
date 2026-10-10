import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  applyAction,
  createInitialState,
  eliminateSide,
  setDrawProposal,
  type Piece,
  type FourShogiState,
} from "@tetraboard/four-shogi";
import {
  fourShogiPublicStateSchema,
  type FourShogiLastRound,
  type FourShogiReplayPage,
} from "@tetraboard/protocol";
import {
  createFourShogiReplayFrame,
  fetchFourShogiReplay,
} from "../src/features/room/fourShogiReplay";

const instanceId = "00000000-0000-4000-8000-000000000001";
const roundId = "00000000-0000-4000-8000-000000000002";
const players = {
  south: "00000000-0000-4000-8000-000000000011",
  west: "00000000-0000-4000-8000-000000000012",
  north: "00000000-0000-4000-8000-000000000013",
  east: "00000000-0000-4000-8000-000000000014",
};
const initial = { mode: "singles" as const, players, threePlayerAttackProhibited: true };
const events: FourShogiReplayPage["events"] = [
  {
    index: 0,
    event: {
      type: "action",
      side: "south",
      action: { type: "movePiece", from: { x: 4, y: 6 }, to: { x: 4, y: 5 }, promote: false },
    },
  },
  { index: 1, event: { type: "eliminate", side: "west", reason: "timeout" } },
  { index: 2, event: { type: "eliminate", side: "north", reason: "disconnected" } },
  { index: 3, event: { type: "eliminate", side: "east", reason: "left" } },
];
function lastRound(): FourShogiLastRound {
  let state: FourShogiState = createInitialState(initial);
  for (const { event } of events) {
    const result =
      event.type === "action"
        ? applyAction(state, event.side, event.action)
        : event.type === "eliminate"
          ? eliminateSide(state, event.side, event.reason)
          : setDrawProposal(state, event.side, event.proposed);
    if (!result.ok) throw new Error("Invalid fixed replay");
    state = result.state;
  }
  const { repetitions: _repetitions, ...display } = state;
  const game = fourShogiPublicStateSchema.parse(display);
  if (game.status !== "finished") throw new Error("Expected finished fixture");
  return {
    roundId,
    game,
    players: Object.entries(players).map(([side, id]) => ({
      side: side as keyof typeof players,
      id,
      name: side,
    })),
    eventCount: events.length,
  };
}
function page(start = 0, end = events.length): FourShogiReplayPage {
  return {
    instanceId,
    roundId,
    rulesVersion: 1,
    initial,
    eventCount: events.length,
    events: events.slice(start, end),
    nextCursor: end < events.length ? end : null,
  };
}
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function serve(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const fetcher = mock((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(new URL(String(input), "https://example.test"), init)),
  );
  globalThis.fetch = fetcher as unknown as typeof fetch;
  return fetcher;
}
function load(signal = new AbortController().signal, round = lastRound()) {
  return fetchFourShogiReplay({ roomId: "12345", instanceId, lastRound: round, signal });
}

describe("四人将棋の直前局棋譜", () => {
  test("分割GETから着手と外部脱落を順に再生し、表示局面に千日手履歴を残さない", async () => {
    const fetcher = serve((url) => {
      expect(url.pathname).toBe(`/api/rooms/12345/rounds/${roundId}/replay`);
      expect(url.searchParams.get("instanceId")).toBe(instanceId);
      return Response.json(url.searchParams.has("cursor") ? page(2) : page(0, 2));
    });
    const frames = await load();
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(
      new URL(String(fetcher.mock.calls[1][0]), "https://example.test").searchParams.get("cursor"),
    ).toBe("2");
    expect(frames.map((frame) => frame.label)).toEqual([
      "開始局面",
      "1: 南5六歩",
      "西 時間切れ",
      "北 通信切れ",
      "東 退室",
    ]);
    expect(frames[0].game.board[6][4]?.kind).toBe("pawn");
    expect(frames[1].game.board[6][4]).toBeNull();
    expect(frames[1].game.board[5][4]).toMatchObject({ kind: "pawn", side: "south" });
    expect(frames[1].game.turn).toBe("west");
    expect(frames[2].game.eliminations).toMatchObject([
      { side: "west", reason: "timeout", rank: 4 },
    ]);
    expect(frames[4].game.status).toBe("finished");
    expect(frames[4].game.result).toMatchObject({
      mode: "singles",
      standings: expect.arrayContaining([{ side: "south", rank: 1 }]),
    });
    expect(frames.every((frame) => !("repetitions" in frame.game))).toBe(true);
    expect(frames[0].checkState).toEqual({ south: false, west: false, north: false, east: false });
  });

  test("別世代・別局・合計件数・ルール版が異なる応答を棋譜として採用しない", async () => {
    for (const changed of [
      { instanceId: "00000000-0000-4000-8000-000000000099" },
      { roundId: "00000000-0000-4000-8000-000000000099" },
      { eventCount: 5 },
      { rulesVersion: 2 },
    ]) {
      serve(() => Response.json({ ...page(), ...changed }));
      await expect(load()).rejects.toThrow();
    }
  });

  test("各ページの初期値と連続index、cursorの進行、終端件数を検証する", async () => {
    for (const corrupt of [
      { ...page(2), initial: { ...initial, threePlayerAttackProhibited: false } },
      { ...page(2), events: [{ ...events[2], index: 1 }, events[3]] },
      { ...page(2), events: [{ ...events[2], index: 3 }, events[3]] },
      { ...page(2), nextCursor: 2 },
      { ...page(2), events: [], nextCursor: 2 },
      { ...page(2), events: [events[2]], nextCursor: null },
    ]) {
      serve((url) => Response.json(url.searchParams.has("cursor") ? corrupt : page(0, 2)));
      await expect(load()).rejects.toThrow();
    }
  });

  test("不正な着手・参加者の不一致・最終局面の不一致・取得失敗を拒否する", async () => {
    serve(() =>
      Response.json({
        ...page(),
        events: [{ ...events[0], event: { ...events[0].event, side: "west" } }, ...events.slice(1)],
      }),
    );
    await expect(load()).rejects.toThrow("event is invalid");
    serve(() =>
      Response.json({
        ...page(),
        initial: { ...initial, players: { ...players, south: players.west } },
      }),
    );
    await expect(load()).rejects.toThrow();
    serve(() => Response.json(page()));
    const round = lastRound();
    round.game.moveNumber++;
    await expect(load(new AbortController().signal, round)).rejects.toThrow(
      "final position mismatch",
    );
    serve(() => Response.json({ error: "conflict" }, { status: 409 }));
    await expect(load()).rejects.toThrow("request failed");
  });

  test("次局開始などでabortされた取得は後続ページや再生を進めない", async () => {
    const controller = new AbortController();
    const fetcher = serve((_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      return Response.json(page(0, 2));
    });
    await expect(load(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher.mock.calls).toHaveLength(1);
  });
});

function tactical(
  pieces: readonly { side: Piece["side"]; kind: Piece["kind"]; x: number; y: number }[],
): FourShogiState {
  const state = createInitialState(initial);
  const board: FourShogiState["board"] = Array.from({ length: 9 }, () =>
    Array<Piece | null>(9).fill(null),
  );
  let id = 1;
  for (const entry of [
    { side: "south" as const, kind: "king" as const, x: 4, y: 8 },
    { side: "west" as const, kind: "king" as const, x: 0, y: 0 },
    { side: "north" as const, kind: "king" as const, x: 8, y: 0 },
    { side: "east" as const, kind: "king" as const, x: 8, y: 8 },
    ...pieces,
  ]) {
    board[entry.y]![entry.x] = { id: id++, side: entry.side, kind: entry.kind, promoted: false };
  }
  return { ...state, board, nextPieceId: id, repetitions: {} };
}

test("同時詰みの局面を保持し、ラベルは着手と次の外部脱落だけを表示する", () => {
  const state = tactical([
    { side: "south", kind: "rook", x: 4, y: 1 },
    { side: "south", kind: "gold", x: 1, y: 2 },
    { side: "south", kind: "gold", x: 7, y: 2 },
  ]);
  const event = {
    type: "action" as const,
    side: "south" as const,
    action: {
      type: "movePiece" as const,
      from: { x: 4, y: 1 },
      to: { x: 4, y: 0 },
      promote: false,
    },
  };
  const result = applyAction(state, event.side, event.action);
  if (!result.ok) throw new Error("Fixed simultaneous mate must be legal");
  const frame = createFourShogiReplayFrame(result.state, { before: state, event });
  expect(frame.label).toBe("1: 南5一飛不成");
  expect(frame.game.eliminations).toMatchObject([
    { side: "west", group: 1 },
    { side: "north", group: 1 },
  ]);
  const leave = { type: "eliminate" as const, side: "east" as const, reason: "left" as const };
  const final = eliminateSide(result.state, leave.side, leave.reason);
  if (!final.ok) throw new Error("Fixed departure must be legal");
  expect(
    createFourShogiReplayFrame(final.state, { before: result.state, event: leave }).label,
  ).toBe("東 退室");
});

test("合法手0件による脱落を局面に保持し、ラベルには着手だけを表示する", () => {
  const state = tactical([
    { side: "south", kind: "gold", x: 1, y: 2 },
    { side: "south", kind: "gold", x: 2, y: 1 },
    { side: "south", kind: "pawn", x: 5, y: 5 },
  ]);
  const event = {
    type: "action" as const,
    side: "south" as const,
    action: {
      type: "movePiece" as const,
      from: { x: 5, y: 5 },
      to: { x: 5, y: 4 },
      promote: false,
    },
  };
  const result = applyAction(state, event.side, event.action);
  if (!result.ok) throw new Error("Fixed immobilization must be legal");
  const frame = createFourShogiReplayFrame(result.state, { before: state, event });
  expect(frame.label).toBe("1: 南4五歩");
  expect(frame.game.eliminations).toContainEqual(
    expect.objectContaining({ side: "west", reason: "no_legal_actions", rank: 4 }),
  );
});
