import type { BoardPublishedPost, BoardReply } from "@tetraboard/protocol/board";
import type { GameId } from "@tetraboard/protocol/games";
import { boardPostIntervalMs, nextBoardPostAt } from "../domain/board";

export type BoardDestination =
  | { gameId: GameId; parentId: null }
  | { gameId: null; parentId: string };

type BoardWrite = BoardDestination & { accountId: string; requestId: string; text: string };
export type BoardWriteAttempt = BoardWrite & { bodyHash: string; postedAtMs: number };

export type BoardWriteResult = {
  accepted: {
    bodyHash: string;
    gameId: GameId;
    parentId: string | null;
    postedAtMs: number;
    post: BoardPublishedPost | null;
    reply: BoardReply | null;
  } | null;
  rejection: {
    eligible: number;
    parentAvailable: number;
    accepting: number;
    stopped: number;
    lastPostedAtMs: number;
  };
};

export interface BoardWriter {
  insertEligiblePost(attempt: BoardWriteAttempt, lastPostByMs: number): Promise<BoardWriteResult>;
}

export async function postToBoard(
  store: BoardWriter,
  input: BoardWrite,
  now: () => number,
  hash: (text: string) => Promise<string>,
) {
  const bodyHash = await hash(input.text);
  const postedAtMs = now();
  const { accepted, rejection } = await store.insertEligiblePost(
    { ...input, bodyHash, postedAtMs },
    postedAtMs - boardPostIntervalMs,
  );
  if (accepted) {
    if (
      accepted.bodyHash !== bodyHash ||
      accepted.parentId !== input.parentId ||
      (input.gameId !== null && accepted.gameId !== input.gameId)
    )
      return { status: "changedReplay" } as const;
    return {
      status: "accepted",
      post: accepted.post,
      reply: accepted.reply,
      availableAtMs: nextBoardPostAt(accepted.postedAtMs),
    } as const;
  }
  if (!rejection.eligible) return { status: "ineligible" } as const;
  if (!rejection.parentAvailable) return { status: "notFound" } as const;
  if (!rejection.accepting || rejection.stopped) return { status: "stopped" } as const;
  return {
    status: "rateLimited",
    availableAtMs: nextBoardPostAt(rejection.lastPostedAtMs),
  } as const;
}
