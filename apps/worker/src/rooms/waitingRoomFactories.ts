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
    settings: { mode: request.mode, timeControl: request.timeControl ?? roomTimeControl },
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
    ? [1, 2, 3].map((index) => ({
        id: crypto.randomUUID(),
        name: `CPU ${index}`,
        kind: "cpu" as const,
        level: 1 as const,
        ready: true as const,
        reconnectDeadline: null,
      }))
    : [];
  return [host, ...cpus];
}
export const waitingRoomFactories = {
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
