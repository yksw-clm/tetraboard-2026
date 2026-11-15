export type EliminationReason = "resigned" | "left" | "timeout" | "disconnected";
export type RatingMethod = "elo" | "skill" | "none";

export interface GameTypes {
  state: unknown;
  seat: string;
  action: unknown;
  event: unknown;
  settings: unknown;
  result: unknown;
  rejection: unknown;
  cpuLevel: unknown;
  history?: unknown;
  replayInitial?: unknown;
  externalOptions?: unknown;
  externalMove?: unknown;
}

export interface GameCatalog<Id extends string, Seat, Settings> {
  readonly id: Id;
  readonly seats: readonly Seat[];
  readonly rating: RatingMethod;
  readonly defaultSettings: Settings;
}

export type GameTransition<State, Event> = { state: State; event: Event };
export type GameActionResult<State, Event, Rejection> =
  | ({ ok: true } & GameTransition<State, Event>)
  | { ok: false; reason: Rejection };

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export interface ExternalCpuDefinition<T extends GameTypes> {
  getPositionKey: (state: T["state"]) => string;
  createRequest: (
    state: T["state"],
    seat: T["seat"],
    level: T["cpuLevel"],
    options: T["externalOptions"],
  ) => JsonObject;
  readMove: (move: T["externalMove"]) => T["action"] | null;
  fallbackAction?: (state: T["state"], seat: T["seat"]) => T["action"] | null;
}

export type ReplayInitial<T extends GameTypes> = T extends { replayInitial: infer Initial }
  ? Initial
  : T["state"];

export interface GameDefinition<T extends GameTypes, Id extends string> {
  readonly catalog: GameCatalog<Id, T["seat"], T["settings"]>;
  readonly rules: {
    createInitialState: (settings: T["settings"]) => T["state"];
    getTurn: (state: T["state"]) => T["seat"] | null;
    applyAction: (
      state: T["state"],
      seat: T["seat"],
      action: T["action"],
      history?: T["history"],
    ) => GameActionResult<T["state"], T["event"], T["rejection"]>;
    requiresTurn?: (action: T["action"]) => boolean;
    endsTurn?: (action: T["action"]) => boolean;
    eliminateSeat: (
      state: T["state"],
      seat: T["seat"],
      reason: EliminationReason,
    ) => GameTransition<T["state"], T["event"]>;
    getResult: (state: T["state"]) => T["result"] | null;
  };
  readonly cpu: {
    readonly external?: ExternalCpuDefinition<T>;
    chooseAction: (
      state: T["state"],
      seat: T["seat"],
      level: T["cpuLevel"],
      random: () => number,
      history?: T["history"],
    ) => T["action"] | null;
  };
  // 初期局面を含めず、各イベントの適用後の状態を順に返します。
  readonly replay: (initial: ReplayInitial<T>, events: readonly T["event"][]) => T["state"][];
}

// 定義済みの予備操作は呼び出し側でも必須の型として保ちます。
export function defineGame<T extends GameTypes, const Id extends string>(
  definition: GameDefinition<T, Id> & { cpu: { external: Required<ExternalCpuDefinition<T>> } },
): GameDefinition<T, Id> & { cpu: { external: Required<ExternalCpuDefinition<T>> } };
export function defineGame<T extends GameTypes, const Id extends string>(
  definition: GameDefinition<T, Id>,
): GameDefinition<T, Id>;
export function defineGame<T extends GameTypes, const Id extends string>(
  definition: GameDefinition<T, Id>,
): GameDefinition<T, Id> {
  return definition;
}
