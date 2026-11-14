import {
  createInitialState as reversiInitial,
  applyAction as reversiApply,
  type FourReversiState,
} from "@tetraboard/four-reversi";
import {
  createInitialState as shogiInitial,
  applyAction as shogiApply,
  getLegalActions,
  type FourShogiState,
} from "@tetraboard/four-shogi";
import { roomSchema, fourShogiPublicStateSchema, type Room } from "@tetraboard/protocol";
import type { Game } from "../src/config";

export const ids = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
export const instanceId = "00000000-0000-4000-8000-000000000010";
export const roundId = "00000000-0000-4000-8000-000000000020";
export const colors = ["black", "white", "red", "blue"] as const;
export const sides = ["south", "west", "north", "east"] as const;
export const token = (i: number) => String(i + 1).repeat(64);
export class GameFixture {
  rev = reversiInitial("singles");
  shogi: FourShogiState;
  members = new Set<number>();
  ready = new Set<number>();
  playing = false;
  rounds = 0;
  moves = 0;
  turnAt = Date.now();
  constructor(
    readonly game: Game,
    readonly prohibited = true,
  ) {
    this.shogi = shogiInitial({
      mode: "singles",
      players: { south: ids[0], west: ids[1], north: ids[2], east: ids[3] },
      threePlayerAttackProhibited: prohibited,
    });
  }
  room(): Room {
    const now = Date.now();
    const players = [...this.members].map((i) => ({
      id: ids[i],
      name: `BOT-${i + 1}`,
      kind: "human",
      ready: this.ready.has(i),
      reconnectDeadline: null,
      ...(this.game === "four-shogi"
        ? { side: this.playing ? sides[i] : null }
        : { color: this.playing ? colors[i] : null }),
    }));
    const settings = {
      game: this.game,
      mode: "singles",
      timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
      ...(this.game === "four-shogi" ? { threePlayerAttackProhibited: this.prohibited } : {}),
    };
    const { repetitions: _repetitions, ...publicShogi } = this.shogi;
    const g = this.game === "four-shogi" ? fourShogiPublicStateSchema.parse(publicShogi) : this.rev;
    const lastRound =
      !this.playing && this.rounds > 0
        ? {
            game: g,
            players: ids.map((id, i) => ({
              id,
              name: `BOT-${i + 1}`,
              ...(this.game === "four-shogi" ? { side: sides[i] } : { color: colors[i] }),
            })),
            ...(this.game === "four-shogi" ? { roundId, eventCount: this.shogi.moveNumber } : {}),
          }
        : null;
    return roomSchema.parse({
      id: "12345",
      instanceId,
      status: this.playing ? "playing" : "waiting",
      settings,
      publicUpdatedAtMs: now,
      lastActivityAtMs: now,
      players,
      eliminations: this.playing && this.game === "four-shogi" ? this.shogi.eliminations : [],
      game: this.playing ? g : null,
      clock: this.playing
        ? {
            remainingMainMs: Object.fromEntries(
              (this.game === "four-shogi" ? sides : colors).map((s) => [s, 300000]),
            ),
            turnStartedAt: this.turnAt,
            turnExpiresAt: this.turnAt + 30000,
          }
        : null,
      lastRound,
      ...(this.game === "four-shogi"
        ? {
            checkState: Object.fromEntries(sides.map((s) => [s, false])),
            roundId: this.playing ? roundId : null,
            positionRevision: this.playing ? this.shogi.moveNumber : 0,
            legalActions: this.playing ? getLegalActions(this.shogi) : [],
            threePlayerAttackForbiddenActions: [],
          }
        : {}),
    });
  }
  start() {
    this.turnAt = Date.now();
    this.rev = reversiInitial("singles");
    this.shogi = shogiInitial({
      mode: "singles",
      players: { south: ids[0], west: ids[1], north: ids[2], east: ids[3] },
      threePlayerAttackProhibited: this.prohibited,
    });
    this.playing = true;
  }
  action(i: number, action: Parameters<typeof reversiApply>[1] | Parameters<typeof shogiApply>[2]) {
    if (this.game === "four-shogi") {
      if (action.type === "placeStone") throw Error("wrong game");
      const result = shogiApply(this.shogi, sides[i], action);
      if (!result.ok) throw Error(result.reason);
      this.shogi = result.state;
    } else {
      if (action.type !== "placeStone" || this.rev.turn !== colors[i]) throw Error("wrong turn");
      const result = reversiApply(this.rev, action);
      if (!result.ok) throw Error(result.reason);
      this.rev = result.state;
    }
    this.moves++;
    this.turnAt = Date.now();
    const state: FourReversiState | FourShogiState =
      this.game === "four-shogi" ? this.shogi : this.rev;
    if (state.status === "finished") {
      this.rounds++;
      this.playing = false;
      this.ready.clear();
    }
  }
}
