import { env } from "cloudflare:workers";
import {
  createInitialState,
  eliminateSide,
  sides,
  type Side,
  type GameMode,
} from "@tetraboard/four-shogi";
import { finishedFourShogiStateSchema, type FourShogiReplayEvent } from "@tetraboard/protocol";
import {
  advanceShogiMatchSave,
  emptyKnockouts,
  type ShogiMatchRecord,
  type ShogiSaveProgress,
} from "../src/rooms/shogiMatchStore";

export function shogiRecord(
  accountId: string | null,
  selfSide: Side = "south",
  mode: GameMode = "singles",
) {
  const players = Object.fromEntries(sides.map((side) => [side, crypto.randomUUID()])) as Record<
    Side,
    string
  >;
  const initial = { mode, players, threePlayerAttackProhibited: true };
  let state = createInitialState(initial);
  const events: FourShogiReplayEvent[] = [];
  for (const side of mode === "singles"
    ? (["east", "north", "west"] as const)
    : (["west"] as const)) {
    const result = eliminateSide(state, side, "left");
    if (!result.ok) throw new Error("Fixture elimination failed");
    state = result.state;
    events.push({ type: "eliminate", side, reason: "left" });
  }
  const { repetitions: _index, ...core } = state;
  const record: ShogiMatchRecord = {
    id: crypto.randomUUID(),
    roomId: "12345",
    instanceId: crypto.randomUUID(),
    startedAtMs: 1700000000000,
    endedAtMs: 1700000001000,
    settings: {
      game: "four-shogi",
      mode,
      threePlayerAttackProhibited: true,
      timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
    },
    participants: sides.map((side, seat) => ({
      id: players[side],
      name: side === selfSide ? "開始時の名前" : `CPU Lv${(seat % 2) + 1}`,
      side,
      seat,
      ...(side === selfSide
        ? { kind: "human" as const, accountId }
        : { kind: "cpu" as const, level: seat % 2 === 0 ? (1 as const) : (2 as const) }),
    })),
    game: finishedFourShogiStateSchema.parse(core),
    knockouts: emptyKnockouts(),
    replay: { rulesVersion: 1, initial, eventCount: events.length },
  };
  return { record, events };
}

export function humanShogiRecord(...args: Parameters<typeof shogiRecord>) {
  const fixture = shogiRecord(...args);
  fixture.record.participants = fixture.record.participants.map((player) => {
    if (player.kind === "human") return player;
    const { level: _level, ...identity } = player;
    return { ...identity, name: "ゲスト", kind: "human", accountId: null };
  });
  return fixture;
}

export async function saveShogiFixture(fixture: ReturnType<typeof shogiRecord>) {
  let progress: ShogiSaveProgress | null = { phase: "upload", cursor: 0 };
  while (progress) {
    progress = await advanceShogiMatchSave(env.APP_DB, fixture.record, progress, (cursor) =>
      fixture.events.slice(cursor, cursor + 100),
    );
  }
}
