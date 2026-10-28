import { isDeepStrictEqual } from "node:util";
import {
  fourShogiRoomSchema,
  getFourShogiReplayContract,
  type FourShogiPublicState,
  type FourShogiRoom,
} from "@tetraboard/protocol";
import {
  advanceAnalysisPosition,
  analysisRuleProfileId,
  restoreAnalysisPosition,
  type AnalysisPosition,
  type AnalysisReplayInput,
} from "@tetraboard/four-shogi/analysis";

export type LiveReplayTarget = Readonly<{
  instanceId: string;
  roundId: string;
  eventCount: number;
  game: FourShogiPublicState;
  finished: boolean;
}>;

export type VerifiedLiveUpdate = LiveReplayTarget &
  Readonly<{
    sourceUrl: string;
    replay: AnalysisReplayInput;
    position: AnalysisPosition;
  }>;

/** 表示snapshotの実手番とrevisionを、取得する完全履歴の終端へ固定します。 */
export function liveReplayTarget(input: unknown): LiveReplayTarget | null {
  const parsed = fourShogiRoomSchema.safeParse(input);
  if (!parsed.success) throw new Error("四人将棋の観戦用ルームを指定してください");
  const room: FourShogiRoom = parsed.data;
  if (room.settings.mode !== "singles")
    throw new Error("ライブ検討は四人将棋シングルスに対応しています");
  if (room.status === "playing")
    return {
      instanceId: room.instanceId,
      roundId: room.roundId,
      eventCount: room.positionRevision,
      game: room.game,
      finished: false,
    };
  if (!room.lastRound) return null;
  return {
    instanceId: room.instanceId,
    roundId: room.lastRound.roundId,
    eventCount: room.lastRound.eventCount,
    game: room.lastRound.game,
    finished: true,
  };
}

export function sameLiveRound(left: LiveReplayTarget, right: LiveReplayTarget) {
  return left.instanceId === right.instanceId && left.roundId === right.roundId;
}

/** 全ページの固定終端と連番を検証し、既知の完全履歴にだけ増分を追加します。 */
export async function restoreLiveReplay(
  sourceUrl: string,
  target: LiveReplayTarget,
  readPage: (cursor: number) => Promise<unknown>,
  previous: VerifiedLiveUpdate | null = null,
): Promise<VerifiedLiveUpdate> {
  if (
    !Number.isSafeInteger(target.eventCount) ||
    target.eventCount < 0 ||
    target.eventCount > 20000
  )
    throw new Error("ライブ棋譜のイベント数が対応範囲を超えています");
  const prior = previous && sameLiveRound(previous, target) ? previous : null;
  if (prior && prior.eventCount > target.eventCount)
    throw new Error("ライブ局面の更新番号が巻き戻っています");
  const events = prior ? [...prior.replay.events] : [];
  let position = prior?.position ?? null;
  let initial = prior?.replay.initial ?? null;
  let cursor = events.length;
  // 初期局面でも一度APIを照合し、未配信のAPIを完全解析として受け入れません。
  do {
    const page = getFourShogiReplayContract.response.parse(await readPage(cursor));
    if (
      page.instanceId !== target.instanceId ||
      page.roundId !== target.roundId ||
      page.rulesVersion !== 1 ||
      page.eventCount !== target.eventCount ||
      (initial !== null && !isDeepStrictEqual(initial, page.initial))
    )
      throw new Error("ライブ棋譜の世代・局・ルール・固定終端が一致しません");
    if (page.initial.mode !== "singles") throw new Error("シングルスの棋譜を指定してください");
    initial ??= { ...page.initial, mode: "singles" };
    position ??= await restoreAnalysisPosition({
      schemaVersion: 1,
      ruleProfileId: analysisRuleProfileId,
      rulesVersion: 1,
      initial,
      events: [],
      eventOffset: 0,
    });
    const next = cursor + page.events.length;
    if (
      next > target.eventCount ||
      (page.nextCursor === null
        ? next !== target.eventCount
        : page.events.length === 0 || page.nextCursor !== next || next >= target.eventCount)
    )
      throw new Error("ライブ棋譜のページに欠落・重複があります");
    for (const entry of page.events) {
      if (entry.index !== cursor) throw new Error("ライブ棋譜のイベントが連続していません");
      position = await advanceAnalysisPosition(position, entry.event);
      events.push(entry);
      cursor++;
    }
    if (page.nextCursor === null) break;
  } while (cursor < target.eventCount);
  if (!initial || !position) throw new Error("ライブ棋譜の開始局面がありません");
  const { repetitions: _repetitions, ...publicState } = position.state;
  if (!isDeepStrictEqual(publicState, target.game))
    throw new Error("ライブ棋譜の復元結果が同じ更新番号の観戦局面と一致しません");
  return {
    ...target,
    sourceUrl,
    replay: {
      schemaVersion: 1,
      ruleProfileId: analysisRuleProfileId,
      rulesVersion: 1,
      initial,
      events,
      eventOffset: target.eventCount,
    },
    position,
  };
}
