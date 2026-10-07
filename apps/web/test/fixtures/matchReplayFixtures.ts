import {
  applyAction,
  createInitialState,
  eliminateColor,
  getLegalMoves,
} from "@tetraboard/four-reversi";
import {
  fourReversiMatchDetailSchema,
  roundReplaySchema,
  type FourReversiMatchDetail,
  type RoomMode,
} from "@tetraboard/protocol";

export function replayMatch(
  mode: RoomMode = "singles",
  normal = false,
  index = 1,
): FourReversiMatchDetail {
  const id = `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`;
  const initial = createInitialState(mode);
  let game = initial;
  const steps: FourReversiMatchDetail["replay"]["steps"] = [];
  function place() {
    const color = game.turn;
    if (!color) throw new Error("Fixture already finished");
    const position = getLegalMoves(game)[0];
    const result = applyAction(game, { type: "placeStone", position });
    if (!result.ok) throw new Error("Fixture move invalid");
    game = result.state;
    steps.push(
      roundReplaySchema.shape.steps.element.parse({
        action: { type: "place", color, position },
        game,
        passedColors: result.passedColors,
      }),
    );
  }
  place();
  const eliminations: FourReversiMatchDetail["eliminations"] = [];
  if (normal) {
    while (game.status === "playing") place();
  } else {
    const entries =
      mode === "singles"
        ? ([
            { color: "white", reason: "timeout" },
            { color: "red", reason: "resigned" },
            { color: "black", reason: "disconnected" },
          ] as const)
        : ([{ color: "white", reason: "left" }] as const);
    for (const entry of entries) {
      const result = eliminateColor(game, entry.color);
      if (!result.ok) throw new Error("Fixture elimination invalid");
      game = result.state;
      eliminations.push(entry);
      steps.push(
        roundReplaySchema.shape.steps.element.parse({
          action: { type: "eliminate", ...entry },
          game,
          passedColors: result.passedColors,
        }),
      );
    }
  }
  if (game.status !== "finished") throw new Error("Fixture should finish");
  const participants: FourReversiMatchDetail["participants"] = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "さしすせそたちつてと",
      kind: "human",
      avatarUrl: null,
      color: "blue",
      seat: 0,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "あいうえおかきくけこ",
      kind: "human",
      avatarUrl: null,
      color: "black",
      seat: 1,
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      name: "CPU Lv1",
      kind: "cpu",
      level: 1,
      color: "white",
      seat: 2,
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      name: "CPU Lv2",
      kind: "cpu",
      level: 2,
      color: "red",
      seat: 3,
    },
  ];
  return fourReversiMatchDetailSchema.parse({
    id,
    roomId: "12345",
    startedAtMs: 1700000000000,
    endedAtMs: 1700000001000,
    settings: { game: "four-reversi", mode, timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 } },
    participants,
    selfPlayerId: participants[1].id,
    game,
    eliminations,
    replay: { id, initial, steps },
  });
}
