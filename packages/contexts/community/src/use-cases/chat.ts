import type { LobbyMessage } from "@tetraboard/protocol/general-lobby";
import {
  chatMessagePage,
  chatPostingState,
  chatPostRejection,
  chatPostWindow,
  chatReadWindow,
  chatRetentionCutoff,
  nextChatPostAt,
  type ChatPage,
  type ChatSender,
  type ChatTournament,
} from "../domain/chat";

type ChatPageRequest = {
  viewer?: string;
  before?: string;
  limit: number;
  tournamentId: number;
};

export type ChatPageQuery = ReturnType<typeof chatReadWindow> & {
  viewer?: string;
  tournamentId: number;
};

export type ChatPageRows = {
  messages: LobbyMessage[];
  accepting: boolean;
  sender: ChatSender | null;
  tournament: ChatTournament | null;
};

export interface ChatReader {
  readPage(query: ChatPageQuery): Promise<ChatPageRows>;
}

export async function readChatPage(
  store: ChatReader,
  { viewer, before, limit, tournamentId }: ChatPageRequest,
  now: () => number,
): Promise<{ page: ChatPage; published: boolean }> {
  const { messages, accepting, sender, tournament } = await store.readPage({
    ...chatReadWindow(before, limit, now()),
    viewer,
    tournamentId,
  });
  return {
    published: tournament !== null,
    page: {
      ...chatMessagePage(messages, limit),
      ...chatPostingState(accepting, sender, tournament, now),
      serverTimeMs: now(),
    },
  };
}

type ChatRequest = { accountId: string; requestId: string; tournamentId: number };
type ChatPost = ChatRequest & { text: string; bodyHash: string; sentAtMs: number };
type AcceptedPost = {
  messageId: string;
  bodyHash: string;
  sentAtMs: number;
  tournamentId: number | null;
};

export interface ChatWriter extends ChatReader {
  // 退会・統合・停止・間隔と再送IDを、書き込みと同時に照合します。
  insertEligiblePost(post: ChatPost, window: ReturnType<typeof chatPostWindow>): Promise<void>;
  // 退会受付後は以前に受理した再送も取得できません。
  readAcceptedPost(request: ChatRequest, afterMs: number): Promise<AcceptedPost | null>;
  readMessage(
    id: string,
    viewer: string,
    tournamentId: number,
    afterMs: number,
  ): Promise<LobbyMessage | null>;
}

export async function postChatMessage(
  store: ChatWriter,
  input: ChatRequest & { text: string },
  now: () => number,
  hash: (text: string) => Promise<string>,
) {
  const sentAtMs = now();
  const bodyHash = await hash(input.text);
  const window = chatPostWindow(sentAtMs);
  await store.insertEligiblePost({ ...input, bodyHash, sentAtMs }, window);
  const accepted = await store.readAcceptedPost(input, window.requestAfterMs);
  if (accepted) {
    if (accepted.bodyHash !== bodyHash || accepted.tournamentId !== input.tournamentId)
      return { status: "changedReplay" } as const;
    const message = await store.readMessage(
      accepted.messageId,
      input.accountId,
      input.tournamentId,
      chatRetentionCutoff(now()),
    );
    return {
      status: "accepted",
      message,
      availableAtMs: nextChatPostAt(accepted.sentAtMs),
    } as const;
  }
  const { page } = await readChatPage(
    store,
    { viewer: input.accountId, limit: 50, tournamentId: input.tournamentId },
    now,
  );
  return {
    status: chatPostRejection(page, sentAtMs),
    availableAtMs: page.availableAtMs,
  };
}
