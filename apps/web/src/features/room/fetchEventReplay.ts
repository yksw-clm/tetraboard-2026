import { replayDataEqual } from "./replayDataEqual";
type EventPage<I, E> = {
  initial: I;
  eventCount: number;
  events: { index: number; event: E }[];
  nextCursor: number | null;
};
/** 通信・ページ境界・最終局面の照合を共用し、裁定は各rulesVersionへ委譲する。 */
export async function fetchEventReplay<I, E, S, F extends { game: { status: string } }>({
  signal,
  path,
  parsePage,
  validateInitial,
  rules,
  finalGame,
  requestError,
}: {
  signal: AbortSignal;
  path: (cursor: number) => string;
  parsePage: (value: unknown) => EventPage<I, E>;
  validateInitial: (initial: I) => boolean;
  rules: {
    initialize: (initial: I) => S;
    applyEvent: (state: S, event: E) => { ok: false } | { ok: true; state: S };
    createFrame: (state: S, event?: E) => F;
  };
  finalGame: unknown;
  requestError?: string;
}): Promise<F[]> {
  let cursor = 0,
    initial: I | null = null,
    state: S | null = null;
  const frames: F[] = [];
  for (;;) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const response = await fetch(path(cursor), {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      if (requestError) throw new Error(requestError);
      throw new Response(null, { status: response.status });
    }
    const page = parsePage(await response.json());
    if (initial === null) {
      initial = page.initial;
      if (!validateInitial(initial)) throw new Error("Replay initial identity mismatch");
      state = rules.initialize(initial);
      frames.push(rules.createFrame(state));
    } else if (!replayDataEqual(initial, page.initial))
      throw new Error("Replay initial options changed");
    const next = cursor + page.events.length;
    if (
      next > page.eventCount ||
      (page.nextCursor === null
        ? next !== page.eventCount
        : page.events.length === 0 || page.nextCursor !== next || next >= page.eventCount)
    )
      throw new Error("Replay pagination mismatch");
    for (const entry of page.events) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (entry.index !== cursor || state === null) throw new Error("Replay event index mismatch");
      const result = rules.applyEvent(state, entry.event);
      if (!result.ok) throw new Error("Replay event is invalid");
      state = result.state;
      frames.push(rules.createFrame(state, entry.event));
      cursor++;
    }
    if (page.nextCursor === null) break;
  }
  const final = frames.at(-1)?.game;
  if (!final || final.status !== "finished" || !replayDataEqual(final, finalGame))
    throw new Error("Replay final position mismatch");
  return frames;
}
