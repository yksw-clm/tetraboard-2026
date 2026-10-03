import { afterEach, expect, test } from "bun:test";
import {
  applyAction,
  createInitialState,
  eliminateSide,
  getLegalActions,
  setDrawProposal,
  type FourShogiState,
  type Side,
} from "@tetraboard/four-shogi";
import {
  fourShogiMatchDetailSchema,
  fourShogiPublicStateSchema,
  type FourShogiLastRound,
  type FourShogiReplayEvent,
} from "@tetraboard/protocol";
import { fetchFourShogiReplay } from "../src/features/room/fourShogiReplay";
import { fetchFourShogiMatchReplay } from "../src/features/room/fourShogiMatchReplay";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const directions = ["south", "west", "north", "east"] as const;
const roundId = "00000000-0000-4000-8000-000000000010";
const instanceId = "00000000-0000-4000-8000-000000000020";
const players = Object.fromEntries(
  directions.map((side, i) => [side, `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`]),
) as Record<Side, string>;

for (const mode of ["singles", "doubles"] as const) {
  test(`${mode}: 提案・取消の分割棋譜をルームと保存済み対局で再現する`, async () => {
    const initial = { mode, players, threePlayerAttackProhibited: true };
    let state = createInitialState(initial);
    const events: { index: number; event: FourShogiReplayEvent }[] = [];
    for (const side of directions) {
      for (const proposed of side === "south" ? [true, false, true] : [true]) {
        const result = setDrawProposal(state, side, proposed);
        if (!result.ok) throw new Error(result.reason);
        state = result.state;
        events.push({ index: events.length, event: { type: "drawProposal", side, proposed } });
      }
      if (state.status === "playing") {
        const action = getLegalActions(state)[0]!;
        const moved = applyAction(state, side, action);
        if (!moved.ok) throw new Error(moved.reason);
        state = moved.state;
        events.push({ index: events.length, event: { type: "action", side, action } });
      }
    }
    const { repetitions: _repetitions, ...core } = state;
    const game = fourShogiPublicStateSchema.parse(core);
    if (game.status !== "finished") throw new Error("Expected finished state");
    const lastRound: FourShogiLastRound = {
      roundId,
      game,
      eventCount: events.length,
      players: directions.map((side) => ({ id: players[side], side, name: side })),
    };
    const match = fourShogiMatchDetailSchema.parse({
      id: roundId,
      roomId: "12345",
      startedAtMs: 100,
      endedAtMs: 200,
      settings: {
        game: "four-shogi",
        mode,
        timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
        threePlayerAttackProhibited: true,
      },
      participants: directions.map((side, seat) => ({
        id: players[side],
        side,
        seat,
        name: side,
        kind: "human",
        avatarUrl: null,
      })),
      selfPlayerId: players.south,
      game,
      knockouts: { south: 0, west: 0, north: 0, east: 0 },
      replay: { rulesVersion: 1, initial, eventCount: events.length },
    });
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input), "https://example.test");
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const page = {
        rulesVersion: 1,
        initial,
        eventCount: events.length,
        events: events.slice(offset, offset + 3),
        nextCursor: offset + 3 < events.length ? offset + 3 : null,
      };
      return Response.json(
        url.pathname.includes("/account/")
          ? { ...page, matchId: roundId }
          : { ...page, instanceId, roundId },
      );
    }) as typeof fetch;
    const signal = new AbortController().signal;
    const roomFrames = await fetchFourShogiReplay({
      roomId: "12345",
      instanceId,
      lastRound,
      signal,
    });
    const savedFrames = await fetchFourShogiMatchReplay(match, signal);
    expect(roomFrames).toEqual(savedFrames);
    expect(roomFrames.slice(0, 4).map((frame) => frame.label)).toEqual([
      "開始局面",
      "南 引分提案",
      "南 引分取消",
      "南 引分提案",
    ]);
    expect(roomFrames[1]!.game.drawProposals).toEqual(["south"]);
    expect(roomFrames[2]!.game.drawProposals).toEqual([]);
    expect(roomFrames.slice(0, 4).map((frame) => frame.game.moveNumber)).toEqual([0, 0, 0, 0]);
    expect(roomFrames.at(-1)?.game).toEqual(game);
    expect(game.result.reason).toBe("agreement");
  });
}

test("提案状態のない旧保存データと旧棋譜の最終状態を正規化して一致させる", async () => {
  const initial = { mode: "singles" as const, players, threePlayerAttackProhibited: true };
  let state: FourShogiState = createInitialState(initial);
  const events: { index: number; event: FourShogiReplayEvent }[] = [];
  for (const side of ["west", "north", "east"] as const) {
    const result = eliminateSide(state, side, "left");
    if (!result.ok) throw new Error(result.reason);
    state = result.state;
    events.push({ index: events.length, event: { type: "eliminate", side, reason: "left" } });
  }
  const { repetitions: _repetitions, drawProposals: _proposals, ...oldGame } = state;
  expect(fourShogiPublicStateSchema.parse(oldGame).drawProposals).toEqual([]);
  const lastRound = {
    roundId,
    game: oldGame,
    eventCount: events.length,
    players: directions.map((side) => ({ id: players[side], side, name: side })),
  } as FourShogiLastRound;
  globalThis.fetch = (async () =>
    Response.json({
      instanceId,
      roundId,
      rulesVersion: 1,
      initial,
      eventCount: events.length,
      events,
      nextCursor: null,
    })) as typeof fetch;
  const frames = await fetchFourShogiReplay({
    roomId: "12345",
    instanceId,
    lastRound,
    signal: new AbortController().signal,
  });
  expect(frames.at(-1)?.game.drawProposals).toEqual([]);
});
