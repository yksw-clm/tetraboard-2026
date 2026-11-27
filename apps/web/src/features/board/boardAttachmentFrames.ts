import {
  assertNever,
  isFourGomokuMatch,
  isFourReversiMatch,
  isFourShogiMatch,
  isGomokuMatch,
  isReversiMatch,
  isShogiMatch,
  type ReplayMatch,
} from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";

function indexFrames<G extends GameId, F extends { label: string; accessibleLabel?: string }>(
  game: G,
  frames: F[],
) {
  const positions: readonly { label: string; accessibleLabel?: string }[] = frames;
  return {
    positions,
    frameAt(position: number) {
      const frame = frames[position];
      return frame ? { game, frame } : null;
    },
  };
}

async function loadAttachmentFrames(match: ReplayMatch, signal: AbortSignal) {
  if (isFourReversiMatch(match)) {
    const { replayFrames } = await import("../room/replayFrames");
    return indexFrames("four-reversi", replayFrames(match));
  }
  if (isReversiMatch(match)) {
    const { reversiReplayFrames } = await import("../room/reversiReplay");
    return indexFrames("reversi", reversiReplayFrames(match));
  }
  if (isGomokuMatch(match)) {
    const { gomokuReplayFrames } = await import("../room/gomokuReplay");
    return indexFrames("gomoku", gomokuReplayFrames(match));
  }
  if (isFourGomokuMatch(match)) {
    const { fourGomokuReplayFrames } = await import("../room/fourGomokuReplay");
    return indexFrames("four-gomoku", fourGomokuReplayFrames(match));
  }
  if (isShogiMatch(match)) {
    const { fetchShogiMatchReplay } = await import("../room/standardShogiMatchReplay");
    return indexFrames("shogi", await fetchShogiMatchReplay(match, signal));
  }
  if (isFourShogiMatch(match)) {
    const { fetchFourShogiMatchReplay } = await import("../room/fourShogiMatchReplay");
    return indexFrames("four-shogi", await fetchFourShogiMatchReplay(match, signal));
  }
  return assertNever(match);
}

export async function loadAttachmentPreview(match: ReplayMatch, signal: AbortSignal) {
  const [frames, { BoardAttachmentBoard }] = await Promise.all([
    loadAttachmentFrames(match, signal),
    import("./BoardAttachmentBoard"),
  ]);
  return { ...frames, Board: BoardAttachmentBoard };
}

export type BoardAttachmentFrame = NonNullable<
  ReturnType<Awaited<ReturnType<typeof loadAttachmentFrames>>["frameAt"]>
>;
