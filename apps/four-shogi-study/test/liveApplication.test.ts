import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInitialState, getLegalActions, type FourShogiState } from "@tetraboard/four-shogi";
import { applyReplayEvent } from "@tetraboard/four-shogi/replay";
import {
  restoreAnalysisPosition,
  type AnalysisReplayInput,
  type FourShogiReplayEvent,
} from "@tetraboard/four-shogi/analysis";
import { evaluateStudyPosition } from "@tetraboard/four-shogi/study-search";
import { fourShogiPublicStateSchema } from "@tetraboard/protocol";
import type { StudyServerEvent, StudySnapshot } from "../src/contracts";
import { StudyStore } from "../src/domain/store";
import { restoreStudyPosition } from "../src/domain/study";
import { LocalStudyApplication } from "../src/server/application";
import { createLiveRoomSession, type VerifiedLiveUpdate } from "../src/server/liveRoom";
import {
  createStudySearchRuntime,
  type StudySearchOptions,
  type StudySearchSnapshot,
} from "../src/search/runtime";

const resources: { app: LocalStudyApplication; directory: string }[] = [];
afterEach(async () => {
  for (const { app, directory } of resources.splice(0)) {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function liveFixture() {
  const instanceId = crypto.randomUUID();
  const roundId = crypto.randomUUID();
  const initial = {
    mode: "singles" as const,
    players: { south: "south", west: "west", north: "north", east: "east" },
    threePlayerAttackProhibited: true,
  };
  let state: FourShogiState = createInitialState(initial);
  const events: { index: number; event: FourShogiReplayEvent }[] = [];
  function append(event: FourShogiReplayEvent) {
    const next = applyReplayEvent(state, event);
    if (!next.ok) throw new Error(next.reason);
    events.push({ index: events.length, event });
    state = next.state;
  }
  for (let ply = 0; ply < 8; ply++)
    append({ type: "action", side: state.turn!, action: getLegalActions(state)[0] });
  for (const side of ["east", "north", "west"] as const)
    append({ type: "eliminate", side, reason: "left" });
  async function update(
    eventCount: number,
    identity: { instanceId?: string; roundId?: string } = {},
  ): Promise<VerifiedLiveUpdate> {
    const replay: AnalysisReplayInput = {
      schemaVersion: 1,
      ruleProfileId: "tetraboard-four-shogi-singles-v1",
      rulesVersion: 1,
      initial,
      events: events.slice(0, eventCount),
      eventOffset: eventCount,
    };
    const position = await restoreAnalysisPosition(replay);
    const { repetitions: _repetitions, ...game } = position.state;
    return {
      sourceUrl: `https://tetraboard.net/rooms/12345?instanceId=${identity.instanceId ?? instanceId}`,
      instanceId: identity.instanceId ?? instanceId,
      roundId: identity.roundId ?? roundId,
      eventCount,
      replay,
      position,
      game: fourShogiPublicStateSchema.parse(game),
      finished: game.status === "finished",
    };
  }
  return { instanceId, roundId, events, update };
}

async function harness(reuse = false) {
  const directory = await mkdtemp(join(tmpdir(), "study-live-application-"));
  const fixture = liveFixture();
  let initial = await fixture.update(2);
  const callbacks: Parameters<typeof createLiveRoomSession>[1][] = [];
  const sessions: { closes: number; reconnects: number }[] = [];
  const factory: typeof createLiveRoomSession = (_input, handlers) => {
    callbacks.push(handlers);
    const session = { closes: 0, reconnects: 0 };
    sessions.push(session);
    return {
      async start() {
        await handlers.onUpdate(initial);
        return initial;
      },
      async reconnect() {
        session.reconnects++;
      },
      close() {
        session.closes++;
        handlers.onStatus({ state: "closed", message: null });
      },
    };
  };
  const searches: StudySearchSnapshot[] = [];
  const searchOptions: StudySearchOptions[] = [];
  const cancelled: string[] = [];
  const held: string[] = [];
  let releases = 0;
  const runtime: typeof createStudySearchRuntime = () => ({
    ...(reuse
      ? {
          async holdFocus(id: string) {
            held.push(id);
          },
          async releaseFocus() {
            releases++;
          },
        }
      : {}),
    async start(input, options, notify = () => {}) {
      searchOptions.push(options);
      const position = await restoreStudyPosition(input);
      const evaluation = evaluateStudyPosition(position);
      const progress: StudySearchSnapshot = {
        id: crypto.randomUUID(),
        stateHash: position.stateHash,
        analysisStateHash: position.stateHash,
        focus: options.focusSide
          ? {
              side: options.focusSide,
              status: "preparing",
              sourceStateHash: position.stateHash,
              analysisStateHash: null,
              prefix: [],
              conditional: false,
              projectionElapsedMs: 0,
              model: null,
              result: null,
              reason: null,
            }
          : null,
        rootSide: position.state.turn,
        status: "running",
        reason: null,
        elapsedMs: 0,
        completedDepth: 0,
        work: 0,
        nodes: 0,
        memoryBytes: 0,
        candidates: [],
        recommendedAction: null,
        analysisRecommendedAction: null,
        evaluation,
        staticEvaluation: evaluation,
        workers: 1,
        diagnostics: {
          searchVersion: "test-live",
          profile: "study",
          selectedRoots: 0,
          legalRoots: 0,
          safetyComplete: false,
        },
      };
      searches.push(progress);
      notify(progress);
      return progress.id;
    },
    get() {
      return null;
    },
    async pause() {},
    async resume() {},
    async cancel(id) {
      cancelled.push(id);
    },
    async close() {},
  });
  const store = new StudyStore(directory);
  const app = new LocalStudyApplication(
    store,
    {
      logicalCpus: 8,
      totalMemoryMb: 16384,
      defaultThreads: 1,
      defaultMemoryMb: 512,
      dataDirectory: directory,
    },
    runtime,
    factory,
  );
  resources.push({ app, directory });
  const notices: StudyServerEvent[] = [];
  app.subscribe((event) => notices.push(event));
  return {
    ...fixture,
    app,
    store,
    searches,
    searchOptions,
    cancelled,
    held,
    releaseCount: () => releases,
    sessions,
    notices,
    setInitial(update: VerifiedLiveUpdate) {
      initial = update;
    },
    async send(update: VerifiedLiveUpdate, sessionIndex = callbacks.length - 1) {
      await callbacks[sessionIndex].onUpdate(update);
    },
    status(
      status: Parameters<Parameters<typeof createLiveRoomSession>[1]["onStatus"]>[0],
      sessionIndex = callbacks.length - 1,
    ) {
      callbacks[sessionIndex].onStatus(status);
    },
    watch() {
      return app.watch({ url: initial.sourceUrl });
    },
  };
}

async function branch(app: LocalStudyApplication, current: StudySnapshot) {
  const selected = await app.command(current.study.id, {
    type: "select",
    expectedRevision: current.study.revision,
    nodeId: current.study.nodes[0].id,
  });
  const played = await app.command(current.study.id, {
    type: "action",
    expectedRevision: selected.study.revision,
    action: selected.legalActions[1],
  });
  return app.command(current.study.id, {
    type: "comment",
    expectedRevision: played.study.revision,
    nodeId: played.study.currentNodeId,
    comment: "この分岐を後で確認する",
  });
}

describe("ライブ対局と検討文書の統合", () => {
  test("確定した次局面だけ探索を保持し、世代を更新して切断・設定変更では解放する", async () => {
    const h = await harness(true);
    const initial = await h.watch();
    const focused = await h.app.command(initial.study.id, {
      type: "settings",
      expectedRevision: initial.study.revision,
      settings: { focusSide: "west" },
    });
    const scope = h.searchOptions.at(-1)!.sessionKey;
    await h.send(await h.update(3));
    const next = await h.app.get(initial.study.id);
    expect(h.held).toContain(focused.analysis!.id);
    expect(h.cancelled).not.toContain(focused.analysis!.id);
    expect(next.analysis!.generation).toBeGreaterThan(focused.analysis!.generation);
    expect(next.analysis!.stateHash).toBe(next.position.stateHash);
    expect(h.searchOptions.at(-1)!.sessionKey).toBe(scope);
    h.status({ state: "reconnecting", message: "切断" });
    await h.send(await h.update(3));
    expect(h.cancelled).toContain(next.analysis!.id);
    const current = await h.app.get(initial.study.id);
    const changed = await h.app.command(initial.study.id, {
      type: "settings",
      expectedRevision: current.study.revision,
      settings: { focusSide: "north" },
    });
    expect(changed.analysis!.focus!.side).toBe("north");
    expect(h.cancelled).toContain(current.analysis!.id);
  });
  test("新しいrevisionの履歴同期中は旧解析を隠し、進行中の探索を取り消す", async () => {
    const h = await harness();
    const first = await h.watch();
    expect(first.analysis).not.toBeNull();
    h.status({ state: "syncing", message: null });
    const pending = await h.app.command(first.study.id, {
      type: "comment",
      nodeId: first.study.currentNodeId,
      comment: "同期中",
      expectedRevision: first.study.revision,
    });
    expect(pending.live?.status).toBe("syncing");
    expect(pending.analysis).toBeNull();
    expect(h.cancelled).toContain(first.analysis!.id);
  });
  test("フォーカス席を変えても追従し、他席の着手と次の対局でも同じ席を解析する", async () => {
    const h = await harness();
    const initial = await h.watch();
    const focused = await h.app.command(initial.study.id, {
      type: "settings",
      expectedRevision: initial.study.revision,
      settings: { focusSide: "west" },
    });
    expect(focused.live?.follow).toBe(true);
    expect(focused.analysis?.focus?.side).toBe("west");
    expect(h.searchOptions.at(-1)?.focusSide).toBe("west");
    await h.send(await h.update(3));
    const moved = await h.app.get(initial.study.id);
    expect(moved.live?.follow).toBe(true);
    expect(moved.analysis?.focus?.side).toBe("west");
    expect(moved.analysis?.stateHash).toBe(moved.position.stateHash);
    const roundId = crypto.randomUUID();
    await h.send(await h.update(1, { roundId }));
    const prior = await h.app.get(initial.study.id);
    const next = await h.app.get(prior.live!.nextStudyId!);
    expect(prior.study.settings.focusSide).toBe("west");
    expect(prior.live?.follow).toBe(false);
    expect(next.study.settings.focusSide).toBe("west");
    expect(next.live?.roundId).toBe(roundId);
    expect(next.live?.follow).toBe(true);
    expect(next.analysis?.focus?.side).toBe("west");
    expect(h.searchOptions.at(-1)?.focusSide).toBe("west");
  });

  test("接続復旧は同じprefixでもフォーカス解析を戻し、旧接続のstatusは新解析を止めない", async () => {
    const h = await harness();
    const initial = await h.watch();
    const focused = await h.app.command(initial.study.id, {
      type: "settings",
      expectedRevision: initial.study.revision,
      settings: { focusSide: "east" },
    });
    const count = h.searches.length;
    h.status({ state: "reconnecting", message: "再接続します" });
    await h.send(await h.update(2));
    const recovered = await h.app.get(focused.study.id);
    expect(h.searches).toHaveLength(count + 1);
    expect(recovered.live?.follow).toBe(true);
    expect(recovered.analysis?.status).toBe("running");
    expect(recovered.analysis?.focus?.side).toBe("east");
    const disconnected = await h.app.command(recovered.study.id, {
      type: "liveDisconnect",
      expectedRevision: recovered.study.revision,
    });
    const reconnected = await h.app.command(disconnected.study.id, {
      type: "liveReconnect",
      expectedRevision: disconnected.study.revision,
    });
    const followed = await h.app.command(reconnected.study.id, {
      type: "liveFollow",
      enabled: true,
      expectedRevision: reconnected.study.revision,
    });
    h.status({ state: "error", message: "以前の接続だけのエラー" }, 0);
    await h.send(await h.update(2), 1);
    const latest = await h.app.get(followed.study.id);
    expect(latest.live?.status).toBe("live");
    expect(latest.analysis?.id).toBe(followed.analysis!.id);
    expect(latest.analysis?.status).toBe("running");
  });

  test("追従中は実戦と解析が進み、局面固定中は分岐とコメントを保って最新へ戻れる", async () => {
    const h = await harness();
    const first = await h.watch();
    expect(first.live?.follow).toBe(true);
    expect(first.live?.eventCount).toBe(2);
    expect(first.analysis?.stateHash).toBe(first.position.stateHash);
    await h.send(await h.update(4));
    const moved = await h.app.get(first.study.id);
    expect(moved.study.currentNodeId).toBe(moved.live!.latestNodeId);
    expect(moved.position.stateHash).toBe((await h.update(4)).position.stateHash);
    expect(h.searches).toHaveLength(2);
    expect(h.cancelled).toContain(first.analysis!.id);
    const held = await branch(h.app, moved);
    expect(held.live?.follow).toBe(false);
    const heldNode = held.study.currentNodeId;
    const heldHash = held.position.stateHash;
    const searchCount = h.searches.length;
    await h.send(await h.update(6));
    const incoming = await h.app.get(first.study.id);
    expect(incoming.live?.eventCount).toBe(6);
    expect(incoming.study.currentNodeId).toBe(heldNode);
    expect(incoming.position.stateHash).toBe(heldHash);
    expect(incoming.study.nodes.find((node) => node.id === heldNode)?.comment).toBe(
      "この分岐を後で確認する",
    );
    expect(h.searches).toHaveLength(searchCount);
    const latest = await h.app.command(first.study.id, {
      type: "liveFollow",
      enabled: true,
      expectedRevision: incoming.study.revision,
    });
    expect(latest.study.currentNodeId).toBe(latest.live!.latestNodeId);
    expect(latest.position.stateHash).toBe((await h.update(6)).position.stateHash);
    expect(latest.analysis?.stateHash).toBe(latest.position.stateHash);
    expect(latest.study.nodes.some((node) => node.id === heldNode)).toBe(true);
    expect(
      (await h.store.load(first.study.id))?.nodes.find((node) => node.id === heldNode)?.comment,
    ).toBe("この分岐を後で確認する");
  });

  test("接続中の再接続と切断後の再接続は同じ検討の分岐を継続する", async () => {
    const h = await harness();
    const first = await h.watch();
    const held = await branch(h.app, first);
    const reconnected = await h.app.command(first.study.id, {
      type: "liveReconnect",
      expectedRevision: held.study.revision,
    });
    expect(reconnected.study.id).toBe(first.study.id);
    expect(h.sessions[0].reconnects).toBe(1);
    const disconnected = await h.app.command(first.study.id, {
      type: "liveDisconnect",
      expectedRevision: reconnected.study.revision,
    });
    expect(disconnected.live?.status).toBe("closed");
    expect(h.sessions[0].closes).toBe(1);
    h.setInitial(await h.update(5));
    const resumed = await h.app.command(first.study.id, {
      type: "liveReconnect",
      expectedRevision: disconnected.study.revision,
    });
    expect(resumed.study.id).toBe(first.study.id);
    expect(resumed.live?.eventCount).toBe(5);
    expect(resumed.study.nodes.find((node) => node.id === held.study.currentNodeId)?.comment).toBe(
      "この分岐を後で確認する",
    );
    expect(resumed.study.currentNodeId).toBe(held.study.currentNodeId);
    const beforeLate = resumed.study.revision;
    await h.send(await h.update(6), 0);
    expect((await h.app.get(first.study.id)).study.revision).toBe(beforeLate);
  });

  test("終局と次局を別の検討に残し、固定した旧局から新局を開く導線を返す", async () => {
    const h = await harness();
    const first = await h.watch();
    const held = await branch(h.app, first);
    await h.send(await h.update(h.events.length));
    expect((await h.app.get(first.study.id)).live?.status).toBe("finished");
    const nextRoundId = crypto.randomUUID();
    await h.send(await h.update(1, { roundId: nextRoundId }));
    const previous = await h.app.get(first.study.id);
    expect(previous.study.currentNodeId).toBe(held.study.currentNodeId);
    expect(previous.study.nodes.find((node) => node.id === held.study.currentNodeId)?.comment).toBe(
      "この分岐を後で確認する",
    );
    expect(previous.live?.nextStudyId).toBeString();
    const next = await h.app.get(previous.live!.nextStudyId!);
    expect(next.study.id).not.toBe(first.study.id);
    expect(next.live?.roundId).toBe(nextRoundId);
    expect(next.live?.follow).toBe(false);
    expect(next.study.nodes).toHaveLength(2);
    expect((await h.app.list()).map((entry) => entry.id).sort()).toEqual(
      [first.study.id, next.study.id].sort(),
    );
    expect(
      h.notices.some(
        (event) =>
          event.type === "snapshot" &&
          event.snapshot.study.id === first.study.id &&
          event.snapshot.live?.nextStudyId === next.study.id,
      ),
    ).toBe(true);
  });

  test("部屋世代が異なる新しい接続は既存の文書と棋譜を上書きしない", async () => {
    const h = await harness();
    const first = await h.watch();
    const held = await branch(h.app, first);
    const other = await h.update(1, {
      instanceId: crypto.randomUUID(),
      roundId: crypto.randomUUID(),
    });
    h.setInitial(other);
    const next = await h.watch();
    expect(next.study.id).not.toBe(first.study.id);
    expect(next.live?.instanceId).toBe(other.instanceId);
    const old = await h.app.get(first.study.id);
    expect(old.study.nodes).toEqual(held.study.nodes);
    expect(old.position.stateHash).toBe(held.position.stateHash);
    expect(old.live?.instanceId).toBe(first.live?.instanceId);
    expect(h.sessions[0].closes).toBe(1);
  });

  test("別の検討を作成・解析している間は旧ライブの進行や次局通知が探索を奪わない", async () => {
    const h = await harness();
    const live = await h.watch();
    const creating = h.app.create({ title: "別局面の検討", settings: { mode: "analysis" } });
    const incoming = h.send(await h.update(4));
    const other = await creating;
    await incoming;
    expect((await h.app.get(live.study.id)).live?.follow).toBe(false);
    const analyzing = await h.app.analyze(other.study.id, {
      command: "start",
      expectedRevision: other.study.revision,
    });
    const searchId = analyzing.analysis!.id;
    const searchCount = h.searches.length;
    await h.send(await h.update(6));
    expect((await h.app.get(other.study.id)).analysis?.id).toBe(searchId);
    expect((await h.app.get(other.study.id)).analysis?.status).toBe("running");
    await h.send(await h.update(1, { roundId: crypto.randomUUID() }));
    expect((await h.app.get(other.study.id)).analysis?.id).toBe(searchId);
    expect((await h.app.get(other.study.id)).analysis?.status).toBe("running");
    expect(h.searches).toHaveLength(searchCount);
    expect(h.cancelled).not.toContain(searchId);
  });

  test("固定していた局面から終局済みの最新へ追従しても探索を起動しない", async () => {
    const h = await harness();
    const first = await h.watch();
    await branch(h.app, first);
    await h.send(await h.update(h.events.length));
    const held = await h.app.get(first.study.id);
    expect(held.position.state.status).toBe("playing");
    const searchCount = h.searches.length;
    const finished = await h.app.command(first.study.id, {
      type: "liveFollow",
      enabled: true,
      expectedRevision: held.study.revision,
    });
    expect(finished.live?.follow).toBe(true);
    expect(finished.study.currentNodeId).toBe(finished.live!.latestNodeId);
    expect(finished.position.state.status).toBe("finished");
    expect(finished.legalActions).toEqual([]);
    expect(finished.analysis).toBeNull();
    expect(h.searches).toHaveLength(searchCount);
  });

  test("保存が失敗したライブ更新は旧prefixを保ち、同じ更新を再試行して復旧できる", async () => {
    const h = await harness();
    const first = await h.watch();
    const update = await h.update(4);
    const originalDirectory = h.store.directory;
    const parkedDirectory = `${originalDirectory}-parked`;
    await rename(originalDirectory, parkedDirectory);
    try {
      await writeFile(originalDirectory, "保存先ディレクトリを利用できない状態");
      await expect(h.send(update)).rejects.toThrow();
      const failed = await h.app.get(first.study.id);
      expect(failed.live?.eventCount).toBe(first.live!.eventCount);
      expect(failed.live?.latestNodeId).toBe(first.live!.latestNodeId);
      expect(failed.study.nodes).toEqual(first.study.nodes);
      expect(failed.position.stateHash).toBe(first.position.stateHash);
    } finally {
      await rm(originalDirectory, { force: true });
      await rename(parkedDirectory, originalDirectory);
    }
    await h.send(update);
    const recovered = await h.app.get(first.study.id);
    expect(recovered.live?.eventCount).toBe(4);
    expect(recovered.position.stateHash).toBe(update.position.stateHash);
    expect((await h.store.load(first.study.id))?.currentNodeId).toBe(recovered.study.currentNodeId);
  });
});
