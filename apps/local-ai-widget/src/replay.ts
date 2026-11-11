import {
  getFourShogiAnalysisReplayContract,
  type FourShogiReplayEvent,
} from "@tetraboard/protocol";
import type { ShogiObservation } from "./model";

/** 完全取得できた棋譜だけを保持し、次のrevisionでは末尾から取得します。 */
export class ShogiReplayCache {
  private scope = "";
  private events: FourShogiReplayEvent[] = [];
  constructor(private fetcher: typeof fetch = fetch) {}
  async load(observation: ShogiObservation, signal: AbortSignal): Promise<FourShogiReplayEvent[]> {
    const scope = JSON.stringify([observation.roomId, observation.instanceId, observation.roundId]);
    const events = scope === this.scope ? [...this.events] : [];
    let count: number | null = null;
    for (;;) {
      const query = new URLSearchParams({
        instanceId: observation.instanceId,
        positionRevision: String(observation.positionRevision),
        cursor: String(events.length),
      });
      const response = await this.fetcher(
        `/api${getFourShogiAnalysisReplayContract.pathFor(observation.roomId, observation.roundId!)}?${query}`,
        { cache: "no-store", credentials: "same-origin", signal },
      );
      if (!response.ok)
        throw Error(
          response.status === 409
            ? "棋譜の取得中に局面が変わりました。最新局面から再解析してください"
            : "進行中の棋譜を取得できません。Workerの対応版と接続を確認してください",
        );
      const page = getFourShogiAnalysisReplayContract.response.parse(await response.json());
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (
        page.instanceId !== observation.instanceId ||
        page.roundId !== observation.roundId ||
        page.positionRevision !== observation.positionRevision ||
        page.initial.threePlayerAttackProhibited !==
          observation.game?.threePlayerAttackProhibited ||
        (count !== null && page.eventCount !== count)
      )
        throw Error("棋譜の対象局面が一致しません");
      count = page.eventCount;
      const next = events.length + page.events.length;
      if (
        next > count ||
        (page.nextCursor === null
          ? next !== count
          : page.events.length === 0 || page.nextCursor !== next || next >= count)
      )
        throw Error("棋譜のページが連続していません");
      for (const entry of page.events) {
        if (entry.index !== events.length) throw Error("棋譜の履歴が不足しています");
        events.push(entry.event);
      }
      if (page.nextCursor === null) break;
    }
    this.scope = scope;
    this.events = events;
    return [...events];
  }
}
