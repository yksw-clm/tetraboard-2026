import { gameCapacity, defaultGameId } from "@tetraboard/protocol/games";
import {
  roomTimeControl,
  type CreateRoomRequest,
  type GameId,
  type RoomFor,
} from "@tetraboard/protocol";

type CreationContext = { code: string; name: string; request: CreateRoomRequest };
export type WaitingRoomFactories = {
  [G in GameId]: (context: CreationContext) => Extract<RoomFor<G>, { status: "waiting" }>;
};
function base({ code, request }: CreationContext) {
  return {
    id: code,
    instanceId: crypto.randomUUID(),
    publicUpdatedAtMs: Date.now(),
    lastActivityAtMs: Date.now(),
    settings: {
      mode: request.mode ?? "singles",
      timeControl: request.timeControl ?? roomTimeControl,
    },
  };
}
function players({ name, request }: CreationContext) {
  const host = {
    id: crypto.randomUUID(),
    name,
    kind: "human" as const,
    avatarUrl: null,
    ready: request.quickPlay,
    reconnectDeadline: null,
  };
  const cpus = request.quickPlay
    ? Array.from({ length: gameCapacity(request.game ?? defaultGameId) - 1 }, (_, i) => i + 1).map(
        (index) => ({
          id: crypto.randomUUID(),
          name: `CPU ${index}`,
          kind: "cpu" as const,
          level: request.cpuLevel ?? 1,
          ready: true as const,
          reconnectDeadline: null,
        }),
      )
    : [];
  return [host, ...cpus];
}
export const waitingRoomFactories = {
  shogi: (context: CreationContext): Extract<RoomFor<"shogi">, { status: "waiting" }> => ({
    ...base(context),
    status: "waiting",
    settings: { game: "shogi", timeControl: context.request.timeControl ?? roomTimeControl },
    players: players(context).map((p) => ({ ...p, side: null })),
    eliminations: [],
    game: null,
    clock: null,
    lastRound: null,
    roundId: null,
    positionRevision: 0,
    legalActions: [],
    checkState: { south: false, north: false },
  }),
  gomoku: (
    context: CreationContext,
  ): WaitingRoomFactories["gomoku"] extends (...args: never[]) => infer R ? R : never => ({
    ...base(context),
    status: "waiting",
    settings: {
      game: "gomoku",
      timeControl: context.request.timeControl ?? roomTimeControl,
      forbiddenRules: context.request.forbiddenRules ?? true,
    },
    roundId: null,
    positionRevision: 0,
    players: players(context).map((p) => ({ ...p, color: null })),
    eliminations: [],
    game: null,
    clock: null,
    lastRound: null,
  }),
  reversi: (
    context: CreationContext,
  ): WaitingRoomFactories["reversi"] extends (...args: never[]) => infer R ? R : never => ({
    ...base(context),
    status: "waiting",
    settings: { game: "reversi", timeControl: context.request.timeControl ?? roomTimeControl },
    players: players(context).map((p) => ({ ...p, color: null })),
    eliminations: [],
    game: null,
    clock: null,
    lastRound: null,
  }),
  "four-reversi": (
    context: CreationContext,
  ): Extract<RoomFor<"four-reversi">, { status: "waiting" }> => {
    const common = base(context);
    return {
      ...common,
      status: "waiting",
      settings: { ...common.settings, game: "four-reversi" },
      players: players(context).map((player) => ({ ...player, color: null })),
      eliminations: [],
      game: null,
      clock: null,
      lastRound: null,
    };
  },
  "four-shogi": (
    context: CreationContext,
  ): Extract<RoomFor<"four-shogi">, { status: "waiting" }> => {
    const common = base(context);
    return {
      ...common,
      status: "waiting",
      settings: {
        ...common.settings,
        game: "four-shogi",
        threePlayerAttackProhibited: context.request.threePlayerAttackProhibited ?? true,
      },
      players: players(context).map((player) => ({ ...player, side: null })),
      eliminations: [],
      game: null,
      clock: null,
      lastRound: null,
      roundId: null,
      positionRevision: 0,
      legalActions: [],
      threePlayerAttackForbiddenActions: [],
      checkState: { south: false, west: false, north: false, east: false },
    };
  },
} satisfies WaitingRoomFactories;
