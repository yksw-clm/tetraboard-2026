import type { Room, PlayerAppearance } from "@tetraboard/protocol";
import { playerAppearance } from "./roomCommonPresentation";

export type ResultPlayer = { id: string; name: string; appearance?: PlayerAppearance };

export function resultPlayer(
  player: ResultPlayer,
  currentPlayers: Room["players"] = [],
): ResultPlayer {
  const current = currentPlayers.find((entry) => entry.id === player.id);
  return {
    ...player,
    appearance: player.appearance ?? (current ? playerAppearance(current) : undefined),
  };
}
