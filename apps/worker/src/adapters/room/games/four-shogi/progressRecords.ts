import { captureEliminatedHands, type FourShogiState } from "@tetraboard/four-shogi";
import type { FourShogiEliminatedHands, FourShogiReplayEvent } from "@tetraboard/protocol";
import type { PlayingFor } from "../gameProgress";
import type { ShogiStore } from "./store";
import { shogiMatchStartKey, type ActiveShogiMatch } from "../../../record/shogiMatchStore";
import { recordFormationUsage } from "../../../record/shogiFormationUsage";
export const shogiEliminatedHandsKey = "shogi-eliminated-hands";
export function saveFourShogiTransition(
  storage: DurableObjectStorage,
  store: ShogiStore,
  room: PlayingFor<"four-shogi">,
  state: FourShogiState,
  event: FourShogiReplayEvent,
) {
  const stored = storage.kv.get<FourShogiEliminatedHands>(shogiEliminatedHandsKey);
  const previous = stored?.roundId === room.roundId ? stored.hands : {};
  const hands = captureEliminatedHands(previous, room.game, state);
  if (hands !== previous) storage.kv.put(shogiEliminatedHandsKey, { roundId: room.roundId, hands });
  store.appendEvent(room.roundId, event);
  const core = store.saveState(room.roundId, state);
  recordMatchAction(storage, room, state, event);
  return core;
}
function recordMatchAction(
  storage: DurableObjectStorage,
  room: PlayingFor<"four-shogi">,
  state: FourShogiState,
  event: FourShogiReplayEvent,
) {
  const active = storage.kv.get<ActiveShogiMatch>(shogiMatchStartKey);
  if (
    active?.start.id === room.roundId &&
    event.type === "action" &&
    room.settings.mode === "singles"
  ) {
    const prior = new Set(room.game.eliminations.map((entry) => entry.side));
    const count = state.eliminations.filter(
      (entry) =>
        entry.reason === "checkmate" && entry.side !== event.side && !prior.has(entry.side),
    ).length;
    active.knockouts[event.side] += count;
    if (
      active.formationUsage &&
      active.start.participants.some(
        (player) => player.side === event.side && player.kind === "human",
      )
    )
      active.formationUsage = recordFormationUsage(
        active.formationUsage,
        room.game,
        state,
        event.side,
      );
    storage.kv.put(shogiMatchStartKey, active);
  }
}
