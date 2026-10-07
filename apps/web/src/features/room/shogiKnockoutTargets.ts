import type { Side } from "@tetraboard/four-shogi";
import type { FourShogiReplayFrame } from "./fourShogiReplay";

export function shogiKnockoutTargets(
  frames: readonly FourShogiReplayFrame[],
): Record<Side, Side[]> {
  const targets: Record<Side, Side[]> = { south: [], west: [], north: [], east: [] };
  for (let index = 1; index < frames.length; index++) {
    const frame = frames[index]!;
    if (frame.event?.type !== "action") continue;
    const prior = new Set(frames[index - 1]!.game.eliminations.map((entry) => entry.side));
    for (const entry of frame.game.eliminations) {
      if (
        entry.reason === "checkmate" &&
        entry.side !== frame.event.side &&
        !prior.has(entry.side)
      ) {
        targets[frame.event.side].push(entry.side);
      }
    }
  }
  return targets;
}
