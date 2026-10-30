import { expect, test } from "bun:test";
import {
  createStudy,
  appendStudyEvent,
  studyPositionInput,
  restoreStudyPosition,
} from "../src/domain/study";
import { getAnalysisLegalActions } from "@tetraboard/four-shogi/analysis";
import { createPonderFocusRuntime } from "../src/search/ponderRuntime";
import { readFocusReuseEnvironment } from "../src/search/focusSettings";
import { focusConditions } from "../src/search/focusRuntime";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  StudySearchRuntime,
  StudySearchSnapshot,
  StudySearchOptions,
} from "../src/search/runtime";
const options: StudySearchOptions = {
  strategy: "dual-continuations",
  sessionKey: "one-game",
  focusSide: "west",
  timeBudgetMs: 250,
  maxDepth: 2,
  rootWidth: 6,
  width: 2,
  extensions: 0,
};
async function done(
  runtime: StudySearchRuntime,
  input: Parameters<StudySearchRuntime["start"]>[0],
  opts = options,
  frames: StudySearchSnapshot[] = [],
) {
  return new Promise<StudySearchSnapshot>((resolve, reject) => {
    void runtime
      .start(input, opts, (s) => {
        frames.push(s);
        if (s.status === "error") reject(Error(s.reason ?? "error"));
        if (s.status === "completed") resolve(s);
      })
      .catch(reject);
  });
}
for (const eliminated of [[], ["east"], ["east", "north"]] as const)
  test(`正本の実着手が予測と一致すると同じ根の完成比較を引継ぐ：${4 - eliminated.length}人/禁止ON`, async () => {
    let study = await createStudy();
    for (const side of eliminated)
      study = await appendStudyEvent(study, { type: "eliminate", side, reason: "left" });
    const runtime: StudySearchRuntime = createPonderFocusRuntime(
      { threads: 1, memoryMb: 256 },
      { mode: "ponder", ponderMs: 200 },
    );
    try {
      const first = await done(runtime, studyPositionInput(study));
      expect(first.focus?.conditional).toBe(true);
      await runtime.holdFocus?.(first.id);
      let next = study;
      for (const x of first.focus!.prefix)
        next = await appendStudyEvent(next, { type: "action", side: x.side, action: x.action });
      const frames: StudySearchSnapshot[] = [];
      const second = await done(runtime, studyPositionInput(next), options, frames);
      expect(second.continuation?.sessionHit).toBe(true);
      expect(second.stateHash).toBe(
        (await restoreStudyPosition(studyPositionInput(next))).stateHash,
      );
      expect(second.id).not.toBe(first.id);
      expect(second.focus?.conditional).toBe(false);
      expect(second.focus?.prefix).toEqual([]);
      expect(second.recommendedAction).not.toBeNull();
      const reused = frames.find((x) => x.completedDepth > 0)!;
      expect(reused.work).toBe(0);
      expect(reused.continuation?.priorWork).toBeGreaterThan(0);
      expect(reused.completedDepth).toBe(first.completedDepth);
    } finally {
      await runtime.close();
    }
  });
test("予測外の合法手・異なるscopeでは新規へ戻り、古い取消で新ジョブを壊さない", async () => {
  const study = await createStudy(),
    runtime: StudySearchRuntime = createPonderFocusRuntime(
      { threads: 1, memoryMb: 256 },
      { mode: "combined", ponderMs: 200 },
    );
  try {
    const first = await done(runtime, studyPositionInput(study));
    await runtime.holdFocus?.(first.id);
    const p = await restoreStudyPosition(studyPositionInput(study));
    const other = getAnalysisLegalActions(p).find(
      (a) => JSON.stringify(a) !== JSON.stringify(first.focus!.prefix[0].action),
    )!;
    const next = await appendStudyEvent(study, {
      type: "action",
      side: p.state.turn!,
      action: other,
    });
    const second = await done(runtime, studyPositionInput(next));
    expect(second.continuation?.sessionHit).toBe(false);
    expect(second.continuation?.priorWork).toBe(0);
    await runtime.cancel(first.id);
    expect(runtime.get(second.id)?.status).toBe("completed");
    await runtime.holdFocus?.(second.id);
    const third = await done(runtime, studyPositionInput(next), {
      ...options,
      sessionKey: "another-game",
    });
    expect(third.continuation?.sessionHit).toBe(false);
  } finally {
    await runtime.close();
  }
});

test("期限で中断した探索の未完枝も同じ根で継続し、旧世代へ通知しない", async () => {
  const study = await createStudy();
  const runtime = createPonderFocusRuntime(
    { threads: 1, memoryMb: 256 },
    { mode: "ponder", ponderMs: 150 },
  );
  const opts = { ...options, maxDepth: 64, rootWidth: 24, width: 6 };
  const oldFrames: StudySearchSnapshot[] = [];
  try {
    const first = await done(runtime, studyPositionInput(study), opts, oldFrames);
    expect(first.reason).toBe("deadline");
    expect(first.continuation?.pauseAcknowledged).toBe(true);
    const oldCount = oldFrames.length;
    let next = study;
    for (const x of first.focus!.prefix)
      next = await appendStudyEvent(next, { type: "action", side: x.side, action: x.action });
    const frames: StudySearchSnapshot[] = [];
    const second = await done(runtime, studyPositionInput(next), opts, frames);
    expect(second.continuation?.sessionHit).toBe(true);
    expect(second.continuation?.priorWork).toBeGreaterThan(0);
    expect(second.work).toBeGreaterThan(0);
    expect(second.continuation?.sessionWork).toBe(second.work + second.continuation!.priorWork);
    expect(second.continuation?.pauseAcknowledged).toBe(true);
    expect(
      new Set(
        frames
          .filter((f) => f.continuation?.sessionHit)
          .map((f) => f.continuation!.retainedBranchEntries),
      ),
    ).toEqual(new Set([first.performance?.branchCacheEntries ?? 0]));
    expect(oldFrames.length).toBe(oldCount);
    expect(frames.every((f) => f.id === second.id && f.stateHash === second.stateHash)).toBe(true);
    expect(runtime.get(first.id)?.status).toBe("completed");
    await runtime.pause(second.id);
    await runtime.resume(second.id);
    expect(runtime.get(second.id)?.status).toBe("running");
    await runtime.pause(second.id);
    expect(runtime.get(second.id)?.reason).toBe("user");
    await runtime.cancel(second.id);
    const fresh = await done(runtime, studyPositionInput(next), opts);
    expect(fresh.continuation?.sessionHit).toBe(false);
  } finally {
    await runtime.close();
  }
});

test("保持期限と設定変更でキャッシュを解放し、同じ局面でも再利用しない", async () => {
  const study = await createStudy();
  const runtime = createPonderFocusRuntime(
    { threads: 1, memoryMb: 256 },
    { mode: "combined", ponderMs: 100, ttlMs: 10 },
  );
  try {
    await done(runtime, studyPositionInput(study));
    await Bun.sleep(20);
    const expired = await done(runtime, studyPositionInput(study));
    expect(expired.continuation?.sessionHit).toBe(false);
    const changed = await done(runtime, studyPositionInput(study), { ...options, extensions: 1 });
    expect(changed.continuation?.sessionHit).toBe(false);
    await runtime.releaseFocus?.();
    const released = await done(runtime, studyPositionInput(study));
    expect(released.continuation?.sessionHit).toBe(false);
  } finally {
    await runtime.close();
  }
});

test("worker異常終了は完成扱いせず、取消と終了で遅延結果を破棄する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ponder-worker-error-"));
  const file = join(directory, "worker.ts");
  await writeFile(
    file,
    "process.send?.({type:'ready'});process.on('message',m=>{if(m.type==='start')process.exit(2);if(m.type==='close')process.exit(0)});",
  );
  const runtime = createPonderFocusRuntime(
    { threads: 1, workerScript: pathToFileURL(file) },
    { mode: "ponder", ponderMs: 300 },
  );
  try {
    const study = await createStudy();
    const failed = await new Promise<StudySearchSnapshot>((resolve, reject) => {
      void runtime
        .start(studyPositionInput(study), options, (s) => {
          if (s.status !== "running") resolve(s);
        })
        .catch(reject);
    });
    expect(failed.status).toBe("error");
    expect(failed.recommendedAction).toBeNull();
    expect(failed.completion).toBeUndefined();
    await runtime.cancel(failed.id);
    await runtime.close();
    await expect(runtime.start(studyPositionInput(study), options)).rejects.toThrow();
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("フォーカス引継ぎは明示指定だけ有効で、既定と不正値を区別する", () => {
  expect(readFocusReuseEnvironment({})).toEqual({
    mode: "off",
    ponderMs: 1000,
    ttlMs: 30000,
    cacheEntries: 1024,
  });
  expect(readFocusReuseEnvironment({ STUDY_FOCUS_REUSE: "combined" }).mode).toBe("combined");
  for (const env of [
    { STUDY_FOCUS_REUSE: "tree" },
    { STUDY_PONDER_MS: "0" },
    { STUDY_FOCUS_TTL_MS: "NaN" },
    { STUDY_FOCUS_CACHE_ENTRIES: "1.5" },
  ])
    expect(() => readFocusReuseEnvironment(env)).toThrow();
});

test("予算依存の広い比較深さは互換キーで区別し、明示した同条件だけ再利用する", () => {
  const short = { ...options, timeBudgetMs: 1000 },
    long = { ...options, timeBudgetMs: 5000 };
  expect(focusConditions({}, short)).not.toBe(focusConditions({}, long));
  expect(focusConditions({}, { ...short, broadDepth: 3 })).toBe(focusConditions({}, long));
});

test("対象外のv5・無制限解析も保持要求と解放で停止する", async () => {
  const study = await createStudy();
  for (const strategy of ["adaptive", "dual-continuations"] as const) {
    const runtime = createPonderFocusRuntime({ threads: 1, memoryMb: 256 }, { mode: "ponder" });
    try {
      const id = await runtime.start(studyPositionInput(study), {
        ...options,
        strategy,
        timeBudgetMs: null,
        maxDepth: 64,
      });
      await runtime.holdFocus?.(id);
      expect(runtime.get(id)?.status).toBe("cancelled");
      const next = await runtime.start(studyPositionInput(study), {
        ...options,
        strategy,
        timeBudgetMs: null,
        maxDepth: 64,
      });
      await runtime.releaseFocus?.();
      expect(runtime.get(next)?.status).toBe("cancelled");
    } finally {
      await runtime.close();
    }
  }
});

test("メモリ上限で終わった探索を一致sessionとして再利用しない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ponder-worker-rss-"));
  const file = join(directory, "worker.ts");
  await writeFile(
    file,
    `const send=process.send.bind(process);process.send=(m)=>{if(m.type==='progress')m.memoryBytes=1024**4;return send(m)};await import(${JSON.stringify(new URL("../src/search/worker.ts", import.meta.url).href)});`,
  );
  const runtime = createPonderFocusRuntime(
    { threads: 1, memoryMb: 256, workerScript: pathToFileURL(file), scheduling: "dynamic" },
    { mode: "ponder", ponderMs: 300 },
  );
  try {
    const study = await createStudy(),
      opts = { ...options, maxDepth: 64 };
    const first = await done(runtime, studyPositionInput(study), opts);
    expect(first.reason).toBe("memory_limit");
    const next = await done(runtime, studyPositionInput(study), opts);
    expect(next.continuation?.sessionHit).toBe(false);
    expect(next.reason).toBe("memory_limit");
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("完成後の取消は公開履歴も取消済みになり、TTL後の再開は新規探索する", async () => {
  const study = await createStudy();
  const runtime = createPonderFocusRuntime(
    { threads: 1, memoryMb: 256 },
    { mode: "ponder", ponderMs: 100, ttlMs: 10 },
  );
  const frames: StudySearchSnapshot[] = [];
  try {
    const first = await done(runtime, studyPositionInput(study), options, frames);
    await runtime.cancel(first.id);
    expect(runtime.get(first.id)?.status).toBe("cancelled");
    expect(runtime.get(first.id)?.recommendedAction).toBeNull();
    const second = await done(runtime, studyPositionInput(study), options, frames);
    await Bun.sleep(20);
    await runtime.resume(second.id);
    const deadline = performance.now() + 1000;
    while (frames.at(-1)?.status === "running" && performance.now() < deadline) await Bun.sleep(5);
    expect(frames.at(-1)?.id).not.toBe(second.id);
    expect(frames.at(-1)?.continuation?.sessionHit).toBe(false);
    expect(frames.at(-1)?.status).toBe("completed");
  } finally {
    await runtime.close();
  }
});

test("非有限の要求予算を窓で隠して受理せず、既存の正しい保持を壊さない", async () => {
  const study = await createStudy(),
    runtime = createPonderFocusRuntime({ threads: 1, memoryMb: 256 }, { mode: "ponder" });
  try {
    await done(runtime, studyPositionInput(study));
    await expect(
      runtime.start(studyPositionInput(study), { ...options, timeBudgetMs: Infinity }),
    ).rejects.toThrow();
    const next = await done(runtime, studyPositionInput(study));
    expect(next.continuation?.sessionHit).toBe(true);
  } finally {
    await runtime.close();
  }
});

test("長く保持する探索のcacheを上限以内にし、明示した小さいcacheも守る", async () => {
  const study = await createStudy();
  for (const spec of [
    { cap: undefined, requested: undefined, expected: 1024 },
    { cap: 64, requested: 32, expected: 32 },
  ]) {
    const runtime = createPonderFocusRuntime(
      { threads: 1, memoryMb: 512 },
      { mode: "ponder", cacheEntries: spec.cap },
    );
    try {
      const s = await done(runtime, studyPositionInput(study), {
        ...options,
        cacheSize: spec.requested,
      });
      expect(s.performance?.contextCacheCapacity).toBe(spec.expected);
    } finally {
      await runtime.close();
    }
  }
});
