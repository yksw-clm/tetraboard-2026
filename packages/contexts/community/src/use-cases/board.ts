import type { BoardPostInput, BoardPublishedPost, BoardReply } from "@tetraboard/protocol/board";
import type { GameId } from "@tetraboard/protocol/games";
import {
  boardPostIntervalMs,
  boardWriteRejection,
  nextBoardPostAt,
  type BoardWriteState,
} from "../domain/board";

export type BoardDestination =
  | { gameId: GameId; parentId: null }
  | { gameId: null; parentId: string };

type BoardWrite = BoardDestination & BoardPostInput & { accountId: string };
export type BoardWriteAttempt = BoardWrite & { bodyHash: string; postedAtMs: number };

export type BoardWriteResult =
  | {
      accepted: {
        bodyHash: string;
        gameId: GameId;
        parentId: string | null;
        postedAtMs: number;
        post: BoardPublishedPost | null;
        reply: BoardReply | null;
      };
    }
  | {
      accepted: null;
      invalidAttachment: boolean;
      rejection: BoardWriteState;
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
  const { text, attachment } = input;
  // 添付なしの再送は、導入前に保存された本文のハッシュとも照合できます。
  const bodyHash = attachment
    ? `attachment:${await hash(JSON.stringify([text, attachment.matchId, attachment.position]))}`
    : await hash(text);
  const postedAtMs = now();
  const lastPostByMs = postedAtMs - boardPostIntervalMs;
  const result = await store.insertEligiblePost({ ...input, bodyHash, postedAtMs }, lastPostByMs);
  const { accepted } = result;
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
  const { rejection, invalidAttachment } = result;
  const rejected = boardWriteRejection(rejection, lastPostByMs);
  if (rejected) return rejected;
  if (invalidAttachment) return { status: "invalidAttachment" } as const;
  throw new Error("Board write did not return a post or a rejection");
}
