import type { ExternalCpuDefinition } from "@tetraboard/game-contract";
import type { FourShogiTypes } from "./definition";
import { getLegalActions } from "./index";

export const fourShogiExternalCpu: Required<ExternalCpuDefinition<FourShogiTypes>> = {
  getPositionKey: (state) => {
    const { repetitions: _history, ...core } = state;
    return JSON.stringify(core);
  },
  createRequest: (state, seat, _level, options) => ({
    api_version: 1,
    rules_version: state.rulesVersion,
    profile_id: options.profile.profileId,
    three_player_attack_prohibited: state.threePlayerAttackProhibited,
    turn: seat,
    events: options.events,
  }),
  readMove: (action) =>
    action.type === "movePiece"
      ? { ...action, from: { ...action.from }, to: { ...action.to } }
      : { ...action, to: { ...action.to } },
  fallbackAction: (state, seat) =>
    state.turn === seat ? (getLegalActions(state)[0] ?? null) : null,
};
