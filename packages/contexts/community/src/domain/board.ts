const indexAgeMs = 24 * 60 * 60 * 1000;
export const boardPostIntervalMs = 30_000;
const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

export function boardPostVisibility(deletedAtMs: number | null, replyCount: number) {
  if (deletedAtMs === null) return "published";
  return replyCount >= 1 ? "placeholder" : "notFound";
}

export function shouldIndexBoardPost({
  production,
  deletedAtMs,
  postedAtMs,
  replyCount,
  text,
  now,
}: {
  production: boolean;
  deletedAtMs: number | null;
  postedAtMs: number;
  replyCount: number;
  text: string;
  now: number;
}) {
  if (!production || deletedAtMs !== null || now - postedAtMs < indexAgeMs) return false;
  return replyCount >= 1 || Array.from(segmenter.segment(text)).length >= 50;
}

export function boardProfileRejection(user: {
  isAnonymous?: number | null;
  profileCompleted: number;
}) {
  if (user.isAnonymous) return "guest";
  if (!user.profileCompleted) return "profileIncomplete";
  return null;
}

export function nextBoardPostAt(postedAtMs: number) {
  return postedAtMs + boardPostIntervalMs;
}

export function boardPostingState(
  state: { accepting: number; stopped: number; lastPostedAtMs: number },
  now: () => number,
) {
  return {
    acceptingPosts: Boolean(state.accepting),
    postingStopped: Boolean(state.stopped),
    availableAtMs: state.lastPostedAtMs ? nextBoardPostAt(state.lastPostedAtMs) : 0,
    serverTimeMs: now(),
  };
}

export type BoardCursor = { postedAtMs: number; id: string };

export function boardPage<T extends BoardCursor>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? `${last.postedAtMs}:${last.id}` : null,
  };
}
