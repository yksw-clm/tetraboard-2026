import type { LobbyChat, LobbyMessage } from "@tetraboard/protocol/general-lobby";

export const lobbyRetentionMs = 7 * 86400000;
const postIntervalMs = 10000;
const tournamentGraceMs = 86400000;

export type ChatPage = LobbyChat & { entered: boolean; closesAtMs: number | null };

export function chatRetentionCutoff(now: number) {
  return now - lobbyRetentionMs;
}

export function chatReadWindow(before: string | undefined, limit: number, now: number) {
  const position = before?.split(":");
  return {
    afterMs: chatRetentionCutoff(now),
    before: position ? { sentAtMs: Number(position[0]), id: position[1]! } : undefined,
    count: limit + 1,
  };
}

export function chatMessagePage(rows: LobbyMessage[], limit: number) {
  const messages = rows.slice(0, limit);
  const last = messages.at(-1);
  return {
    messages: messages.reverse(),
    nextCursor: rows.length > limit && last ? `${last.sentAtMs}:${last.id}` : null,
  };
}

export type ChatSender = { stopped: boolean; lastSentAtMs: number };
export type ChatTournament = { accepting: boolean; finalizedAtMs: number | null; entered: boolean };

export function nextChatPostAt(sentAtMs: number) {
  return sentAtMs + postIntervalMs;
}

export function chatPostWindow(now: number) {
  return {
    lastPostByMs: now - postIntervalMs,
    finalizedAfterMs: now - tournamentGraceMs,
    requestAfterMs: chatRetentionCutoff(now),
  };
}

export function chatPostingState(
  accepting: boolean,
  sender: ChatSender | null,
  tournament: ChatTournament | null,
  now: () => number,
) {
  const closesAtMs =
    tournament?.finalizedAtMs == null ? null : tournament.finalizedAtMs + tournamentGraceMs;
  return {
    acceptingPosts:
      accepting && Boolean(tournament?.accepting) && (closesAtMs === null || now() < closesAtMs),
    postingStopped: Boolean(sender?.stopped),
    availableAtMs: sender ? nextChatPostAt(sender.lastSentAtMs) : 0,
    entered: Boolean(tournament?.entered),
    closesAtMs,
  };
}

export function chatProfileRejection(user: {
  profileCompleted: number;
  isAnonymous?: number | null;
  guestNameCustomized?: number | null;
}) {
  if (!user.profileCompleted) return "profileIncomplete";
  if (user.isAnonymous && !user.guestNameCustomized) return "guestNameRequired";
  return null;
}

export function chatPostRejection(page: ChatPage, sentAtMs: number) {
  if (page.closesAtMs != null && sentAtMs >= page.closesAtMs) return "closed";
  if (!page.entered) return "entryRequired";
  if (!page.acceptingPosts || page.postingStopped) return "stopped";
  return "rateLimited";
}
