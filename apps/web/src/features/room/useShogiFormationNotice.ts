import { detectFormations, formationAnalysisVersion, formationIds } from "@tetraboard/four-shogi";
import type { FourShogiRoom } from "@tetraboard/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { advanceFormationTracker, initialFormationTracker } from "./shogiFormationNotice";

function readSeen(key: string, scope: string | null): string[] {
  try {
    const data: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      data &&
      typeof data === "object" &&
      "scope" in data &&
      data.scope === scope &&
      "seen" in data &&
      Array.isArray(data.seen) &&
      data.seen.length <= formationIds.length &&
      data.seen.every((id) => typeof id === "string" && formationIds.some((known) => known === id))
    )
      return data.seen;
  } catch {
    /* 保存領域を利用できなくても、その場の通知は継続します。 */
  }
  return [];
}

export function useShogiFormationNotice(
  room: FourShogiRoom,
  playerId: string | undefined,
  ready: boolean,
) {
  const key = `tetraboard:room:${room.instanceId}:${playerId ?? "spectator"}:formations`;
  const observation = useMemo(() => {
    const self = room.players.find((entry) => entry.id === playerId);
    const playing = room.status === "playing" && self?.side != null;
    const side = playing ? self.side : null;
    return {
      scope: playing
        ? `${room.instanceId}:${playerId}:${room.roundId}:${formationAnalysisVersion}`
        : null,
      ready: !!(ready && playing && !room.game.eliminations.some((entry) => entry.side === side)),
      revision: room.positionRevision,
      moveNumber: playing ? room.game.moveNumber : 0,
      ownMove: !!(playing && room.game.lastMove?.side === side),
      matches: playing ? detectFormations(room.game, self.side) : [],
    };
  }, [room, playerId, ready]);
  const [tracker, setTracker] = useState(() =>
    initialFormationTracker(observation, readSeen(key, observation.scope)),
  );
  let current = tracker;
  if (tracker.observation !== observation) {
    current = advanceFormationTracker(tracker, observation);
    setTracker(current);
  }
  useEffect(() => {
    if (tracker.observation.scope === null) return;
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({ scope: tracker.observation.scope, seen: tracker.seen }),
      );
    } catch {
      /* 再読み込みをまたぐ抑止だけを省略し、対局操作は続けます。 */
    }
  }, [key, tracker.observation.scope, tracker.seen]);
  useEffect(() => {
    const notice = tracker.notice;
    if (notice === null) return;
    const timer = window.setTimeout(
      () =>
        setTracker((previous) =>
          previous.notice === notice ? { ...previous, notice: null } : previous,
        ),
      2000,
    );
    return () => window.clearTimeout(timer);
  }, [tracker.notice]);
  const dismiss = useCallback(
    () =>
      setTracker((previous) =>
        previous.notice === null ? previous : { ...previous, notice: null },
      ),
    [],
  );
  return { notice: current.notice, dismiss };
}
