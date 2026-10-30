import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { LocalStudyApplication } from "../src/server/application";
import { createStudyHttpHandler } from "../src/server/http";
import { StudyStore } from "../src/domain/store";
import { createGuardedStudySearchRuntime } from "../src/search/guardedRuntime";
import { guardBenchIdentity } from "./lethalGuardBench";
import { restoreStudyPosition } from "../src/domain/study";
import type { StudySnapshot } from "../src/contracts";
import type { StudyLifecycleEvent } from "../src/search/deadline";
import type { Side } from "@tetraboard/four-shogi";

/** 実loopback HTTPの操作確認です。人間の画面操作・手動着手時間とは分けて記録します。 */
export async function tournamentManualSmoke(directory: string) {
  const events: StudyLifecycleEvent[] = [],
    rows: unknown[] = [];
  const observe = (event: StudyLifecycleEvent) => {
    if (events.length < 20000) events.push(event);
  };
  const dataDirectory = join(directory, "manual-smoke", "data");
  mkdirSync(dataDirectory, { recursive: true });
  const config = {
    logicalCpus: 10,
    totalMemoryMb: 24576,
    defaultThreads: 4,
    defaultMemoryMb: 4096,
    dataDirectory,
  };
  let app = new LocalStudyApplication(
    new StudyStore(dataDirectory),
    config,
    (options) =>
      createGuardedStudySearchRuntime(
        { ...options, measureStages: true, observeLifecycle: observe },
        { mode: "off" },
      ),
    undefined,
    observe,
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const response = await createStudyHttpHandler(
        app,
        config,
        "/private/tmp/no-assets",
        observe,
      )(request);
      if (request.headers.get("x-smoke-delay") === "150") await Bun.sleep(150);
      return response;
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const request = async (path: string, body?: unknown) => {
    const start = performance.now();
    const response = await fetch(
      origin + path,
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const value = await response.json();
    return { status: response.status, value, elapsedMs: performance.now() - start };
  };
  const checked = async (path: string, body?: unknown): Promise<StudySnapshot> => {
    const result = await request(path, body);
    if (result.status >= 400) throw Error(JSON.stringify(result));
    return result.value as StudySnapshot;
  };
  const save = (complete: boolean) =>
    writeFileSync(
      join(directory, "manual-smoke", "http-smoke.json"),
      JSON.stringify({
        source: guardBenchIdentity(),
        scope:
          "real loopback HTTP/API and canonical state, no browser automation or human timing claim",
        rows,
        events,
        complete,
        humanThirtySecondRehearsal: "not measured",
        officialAiPermission: "unconfirmed: practice/exhibition only",
      }),
    );
  try {
    let last: StudySnapshot | null = null;
    for (const side of ["south", "west", "north", "east"] as Side[]) {
      const record = JSON.parse(
        readFileSync(join(directory, "inputs", `tournament-opening-${side}.json`), "utf8"),
      );
      for (const budgetMs of [5000, 10000]) {
        let current = await checked("/api/import", { data: record.replay });
        const seats = Object.fromEntries(
          ["south", "west", "north", "east"].map((s) => [
            s,
            { controller: "human", thinkTimeMs: 5000 },
          ]),
        );
        current = await checked(`/api/studies/${current.study.id}/commands`, {
          expectedRevision: current.study.revision,
          type: "settings",
          settings: {
            mode: "analysis",
            seats,
            focusSide: side,
            analysisTimeMs: budgetMs,
            threads: 4,
            memoryMb: 4096,
            searchStrategy: "adaptive",
          },
        });
        const started = performance.now();
        const start = await request(`/api/studies/${current.study.id}/analysis`, {
          expectedRevision: current.study.revision,
          command: "start",
        });
        if (start.status !== 200) throw Error("解析開始失敗");
        const stopAt = started + budgetMs + 2000;
        do {
          await Bun.sleep(20);
          current = await checked(`/api/studies/${current.study.id}`);
        } while (current.analysis?.status === "running" && performance.now() < stopAt);
        const elapsedMs = performance.now() - started;
        const analysis = current.analysis;
        const legal =
          !!analysis?.recommendedAction &&
          current.legalActions.some(
            (a) => JSON.stringify(a) === JSON.stringify(analysis.recommendedAction),
          );
        const complete = analysis?.status === "completed" && analysis.completedDepth > 0;
        const matches =
          analysis?.stateHash === current.position.stateHash &&
          analysis.focus?.side === side &&
          current.position.state.turn === side &&
          !analysis.focus?.conditional;
        if (!legal || !complete || !matches || !current.position.state.threePlayerAttackProhibited)
          throw Error("合法性/席/履歴/完成条件に不一致");
        const originalHash = current.position.stateHash;
        const originalId = analysis.id;
        const played = await checked(`/api/studies/${current.study.id}/commands`, {
          expectedRevision: current.study.revision,
          type: "action",
          action: analysis.recommendedAction,
        });
        const stale = await request(`/api/studies/${played.study.id}/analysis`, {
          expectedRevision: played.study.revision,
          command: "adopt",
          analysisId: originalId,
          stateHash: originalHash,
        });
        const staleRejected = stale.status === 409;
        const exported = await request(`/api/studies/${played.study.id}/export`);
        const restored = await checked("/api/import", { data: exported.value });
        const restoredHash = restored.position.stateHash === played.position.stateHash;
        if (!staleRejected || !restoredHash || played.analysis?.id === originalId)
          throw Error("古い解析拒否/履歴往復の不一致");
        const automaticFlowMs = performance.now() - started;
        rows.push({
          side,
          budgetMs,
          analysisResponseMs: elapsedMs,
          automaticFlowMs,
          analysisStartHttpMs: start.elapsedMs,
          automaticLocalFlowWithin30Seconds: automaticFlowMs < 30000,
          remainingForHumanMs: 30000 - automaticFlowMs,
          legal,
          complete,
          matches,
          stateHash: originalHash,
          staleRejected,
          restoredHash,
          repetitionsPreserved:
            JSON.stringify(restored.position.state.repetitions) ===
            JSON.stringify(played.position.state.repetitions),
          status: analysis.status,
          completion: analysis.completion,
        });
        last = restored;
        save(false);
      }
    }
    if (!last) throw Error("操作対象なし");
    const delayStarted = performance.now();
    const delayed = fetch(origin + `/api/studies/${last.study.id}`, {
      headers: { "x-smoke-delay": "150" },
    });
    await Bun.sleep(30);
    const latest = await checked(`/api/studies/${last.study.id}/commands`, {
      expectedRevision: last.study.revision,
      type: "comment",
      nodeId: last.study.currentNodeId,
      comment: "遅延応答の確認",
    });
    const delayedSnapshot = (await (await delayed).json()) as StudySnapshot;
    rows.push({
      kind: "delayed-http",
      responseMs: performance.now() - delayStarted,
      staleRevision: delayedSnapshot.study.revision < latest.study.revision,
      scope:
        "150ms transport delay injected after response construction; UI rejection independently verified by DOM tests",
    });
    last = latest;
    const oldHash = last.position.stateHash,
      id = last.study.id;
    await app.close();
    app = new LocalStudyApplication(new StudyStore(dataDirectory), config);
    const afterRestart = await checked(`/api/studies/${id}`);
    const expected = await restoreStudyPosition({
      origin: afterRestart.study.origin,
      events: afterRestart.study.nodes.filter((n) => n.event).map((n) => n.event!),
    });
    rows.push({
      kind: "application-restart",
      preservedHash: afterRestart.position.stateHash === oldHash,
      canonicalHistoryHash: expected.stateHash === oldHash,
    });
    if (afterRestart.position.stateHash !== oldHash || expected.stateHash !== oldHash)
      throw Error("再起動後の履歴不一致");
    save(true);
  } finally {
    await server.stop(true);
    await app.close();
  }
  console.log(
    JSON.stringify({ httpSmoke: "completed", rows: rows.length, humanTiming: "unmeasured" }),
  );
}

if (import.meta.main) await tournamentManualSmoke(resolve(Bun.argv[2]));
