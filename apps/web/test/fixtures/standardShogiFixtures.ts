import {
  createInitialState,
  applyAction,
  getActionAvailability,
  getCheckState,
  type ShogiState,
  type ShogiAction,
} from "@tetraboard/shogi";
import {
  shogiPublicStateSchema,
  shogiRoomSchema,
  shogiMatchDetailSchema,
  type ShogiMatchReplayPage,
} from "@tetraboard/protocol";
import { waitingRoom, playerIds, now } from "./rooms";

export function standardWaitingRoom() {
  const base = waitingRoom();
  return shogiRoomSchema.parse({
    ...base,
    settings: { game: "shogi", timeControl: base.settings.timeControl },
    players: base.players.slice(0, 2).map(({ color: _color, ...p }) => ({ ...p, side: null })),
    eliminations: [],
    roundId: null,
    positionRevision: 0,
    legalActions: [],
    checkState: { south: false, north: false },
  });
}
export function standardInitialState() {
  const state = createInitialState({ players: { south: playerIds[0], north: playerIds[1] } });
  if (state.status !== "playing") throw Error("Expected initial playing");
  return state;
}
export function standardPublicState(state: ShogiState) {
  const { repetitions: _index, ...core } = state;
  return shogiPublicStateSchema.parse(core);
}
export function standardPlayingRoom(state: ShogiState = standardInitialState(), revision = 0) {
  const room = standardWaitingRoom();
  const parsed = shogiRoomSchema.parse({
    ...room,
    status: "playing",
    roundId: "00000000-0000-4000-8000-000000000020",
    positionRevision: revision,
    players: room.players.map((p, i) => ({ ...p, side: i === 0 ? "south" : "north", ready: true })),
    game: standardPublicState(state),
    ...getActionAvailability(state),
    checkState: getCheckState(state),
    clock: {
      remainingMainMs: { south: 300000, north: 300000 },
      turnStartedAt: now,
      turnExpiresAt: now + 330000,
    },
  });
  if (parsed.status !== "playing") throw Error("Expected playing");
  return parsed;
}
export function standardSavedRound() {
  let game: ShogiState = standardInitialState();
  const initial = { players: game.players };
  const events: ShogiMatchReplayPage["events"] = [];
  const cycle: ShogiAction[] = [
    { type: "movePiece", from: { x: 3, y: 8 }, to: { x: 3, y: 7 }, promote: false },
    { type: "movePiece", from: { x: 3, y: 0 }, to: { x: 3, y: 1 }, promote: false },
    { type: "movePiece", from: { x: 3, y: 7 }, to: { x: 3, y: 8 }, promote: false },
    { type: "movePiece", from: { x: 3, y: 1 }, to: { x: 3, y: 0 }, promote: false },
  ];
  for (let n = 0; n < 12; n++) {
    if (game.status !== "playing") throw Error("Finished early");
    const action = cycle[n % 4],
      side = game.turn;
    const next = applyAction(game, side, action);
    if (!next.ok) throw Error(next.reason);
    events.push({ index: n, event: { type: "action", side, action } });
    game = next.state;
  }
  const match = shogiMatchDetailSchema.parse({
    id: "00000000-0000-4000-8000-000000000020",
    roomId: "12345",
    startedAtMs: 100,
    endedAtMs: 200,
    settings: { game: "shogi", timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 } },
    participants: (["south", "north"] as const).map((side, seat) => ({
      id: initial.players[side],
      side,
      seat,
      name: side,
      kind: "human",
      avatarUrl: null,
    })),
    selfPlayerId: playerIds[1],
    game: standardPublicState(game),
    replay: { rulesVersion: 1, initial, eventCount: events.length },
  });
  const page = (offset: number): ShogiMatchReplayPage => ({
    matchId: match.id,
    rulesVersion: 1,
    initial,
    eventCount: events.length,
    events: events.slice(offset, offset + 5),
    nextCursor: offset + 5 < events.length ? offset + 5 : null,
  });
  return { match, page };
}
