import {
  applyAction,
  createInitialState,
  eliminateSide,
  setDrawProposal,
  getLegalActions,
  sides,
  type FourShogiState,
} from "@tetraboard/four-shogi";
import {
  fourShogiMatchDetailSchema,
  getMatchReplayContract,
  type FourShogiAccountStats,
  type FourShogiMatchDetail,
  type FourShogiMatchSummary,
  type FourShogiReplayEvent,
  type MatchReplayPage,
  type RoomMode,
} from "@tetraboard/protocol";
import { publicShogiState } from "./fourShogiFixtures";

export const shogiStats: FourShogiAccountStats = {
  singles: { total: 8, first: 2, second: 3, third: 1, fourth: 2, knockouts: 11, perfectWins: 1 },
  doubles: { total: 5, wins: 1, losses: 3, draws: 1 },
};

// 標準初期局面から公開エンジンを通す固定棋譜。画像や表示部品の内部状態は差し替えません。
export function shogiReplayMatch(mode: RoomMode = "singles", index = 1) {
  const participants: FourShogiMatchDetail["participants"] = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "さしすせそたちつてと",
      kind: "human",
      avatarUrl: null,
      side: "north",
      seat: 0,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "あいうえおかきくけこ",
      kind: "human",
      avatarUrl: null,
      side: "west",
      seat: 1,
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      name: "CPU Lv1",
      kind: "cpu",
      level: 1,
      side: "south",
      seat: 2,
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      name: "CPU Lv2",
      kind: "cpu",
      level: 2,
      side: "east",
      seat: 3,
    },
  ];
  const initial = {
    mode,
    threePlayerAttackProhibited: true,
    players: Object.fromEntries(participants.map((p) => [p.side, p.id])) as Record<
      (typeof sides)[number],
      string
    >,
  };
  let state: FourShogiState = createInitialState(initial);
  const states: FourShogiState[] = [state];
  const events: MatchReplayPage["events"] = [];
  let seed = 1;
  const advance = (event: FourShogiReplayEvent) => {
    const result =
      event.type === "action"
        ? applyAction(state, event.side, event.action)
        : event.type === "eliminate"
          ? eliminateSide(state, event.side, event.reason)
          : setDrawProposal(state, event.side, event.proposed);
    if (!result.ok) throw new Error(`Invalid fixed shogi replay: ${result.reason}`);
    events.push({ index: events.length, event });
    state = result.state;
    states.push(state);
  };
  // 100着手の列には捕獲・打ち駒・成りが含まれ、ページ境界の後に脱落を記録します。
  for (let move = 0; move < (mode === "singles" ? 100 : 1); move++) {
    if (state.status !== "playing") throw new Error("Fixed shogi replay ended too early");
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const legal = getLegalActions(state);
    advance({ type: "action", side: state.turn, action: legal[seed % legal.length]! });
  }
  for (const side of mode === "singles"
    ? (["west", "east", "south"] as const)
    : (["west"] as const))
    advance({ type: "eliminate", side, reason: side === "east" ? "timeout" : "left" });
  if (state.status !== "finished") throw new Error("Expected finished saved shogi replay");
  const detail = fourShogiMatchDetailSchema.parse({
    id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
    roomId: "12345",
    startedAtMs: 1700000000000,
    endedAtMs: 1700000001000,
    settings: {
      game: "four-shogi",
      mode,
      threePlayerAttackProhibited: true,
      timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
    },
    participants,
    selfPlayerId: participants[0]!.id,
    game: publicShogiState(state),
    knockouts: { south: 0, west: 0, north: 0, east: 0 },
    replay: { rulesVersion: 1, initial, eventCount: events.length },
  });
  const page = (cursor = 0): MatchReplayPage =>
    getMatchReplayContract.response.parse({
      matchId: detail.id,
      rulesVersion: 1,
      initial,
      eventCount: events.length,
      events: events.slice(cursor, cursor + 100),
      nextCursor: cursor + 100 < events.length ? cursor + 100 : null,
    });
  const summary: FourShogiMatchSummary = {
    id: detail.id,
    game: "four-shogi",
    mode,
    startedAtMs: detail.startedAtMs,
    endedAtMs: detail.endedAtMs,
    participants: detail.participants,
    result: detail.game.result,
  };
  return { detail, summary, events, states, page };
}
