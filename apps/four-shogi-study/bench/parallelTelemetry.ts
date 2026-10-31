import type { StudyParallelEvent } from "../src/search/runtime";

type Phase = "prepare" | "broad" | "deep" | "adaptive";
export function createParallelRecorder(threads: number) {
  const events: StudyParallelEvent[] = [];
  return {
    observe(event: StudyParallelEvent) {
      if (events.length >= 200000) throw new Error("並列計測イベント上限です");
      events.push(event);
    },
    summarize(id: string) {
      const rows = events.filter((e) => e.id === id);
      const end = Math.max(
        0,
        ...rows.map(
          (e) => e.atMs + (e.type === "parent" ? e.wallMs : e.type === "ipc" ? e.callMs : 0),
        ),
      );
      const workers = Array.from({ length: threads }, () => ({
        activeMs: 0,
        cpuMs: 0,
        work: 0,
        nodes: 0,
        rss: 0,
        restoreMs: 0,
        createMs: 0,
        taskInitMs: 0,
        taskInitCpuMs: 0,
        processCpuMs: 0,
        restoreCpuMs: 0,
        createCpuMs: 0,
        transport: { sendCalls: 0, jsonBytes: 0, sendMs: 0, sizingMs: 0 },
      }));
      const phaseWorkers = Object.fromEntries(
        (["prepare", "broad", "deep", "adaptive"] as Phase[]).map((phase) => [
          phase,
          Array.from({ length: threads }, () => ({ activeMs: 0, cpuMs: 0, assignedMs: 0 })),
        ]),
      ) as Record<Phase, { activeMs: number; cpuMs: number; assignedMs: number }[]>;
      const phases = Object.fromEntries(
        (["prepare", "broad", "deep", "adaptive"] as Phase[]).map((phase) => [
          phase,
          {
            wallMs: 0,
            activeMs: 0,
            cpuMs: 0,
            assigned: 0,
            completed: 0,
            concurrencyAreaMs: 0,
            peakConcurrent: 0,
          },
        ]),
      ) as Record<
        Phase,
        {
          wallMs: number;
          activeMs: number;
          cpuMs: number;
          assigned: number;
          completed: number;
          concurrencyAreaMs: number;
          peakConcurrent: number;
        }
      >;
      const tasks = new Map<
        number,
        {
          taskId: number;
          role: "root" | "subtree" | "finish";
          outcome?: "split" | "subtree";
          worker: number;
          index: number;
          depth: number;
          phase: Phase;
          startMs: number;
          endMs: number | null;
          complete: boolean;
          work: number;
          nodes: number;
          activeMs: number;
          cpuMs: number;
          before: { work: number; nodes: number; activeMs: number; cpuMs: number };
        }
      >();
      const intervals: {
        phase: Phase;
        startMs: number;
        endMs: number;
        depth: number;
        complete: boolean;
      }[] = [];
      let iteration: { phase: Phase; startMs: number; depth: number } | null = null;
      for (const event of rows) {
        if (event.type === "iteration") {
          if (iteration) intervals.push({ ...iteration, endMs: event.atMs, complete: false });
          iteration = { phase: event.phase, startMs: event.atMs, depth: event.depth };
        } else if (event.type === "iterationEnd" && iteration) {
          intervals.push({ ...iteration, endMs: event.atMs, complete: true });
          iteration = null;
        } else if (event.type === "assigned") {
          phases[event.phase].assigned++;
          const w = workers[event.worker];
          tasks.set(event.taskId, {
            taskId: event.taskId,
            role: event.role ?? "root",
            worker: event.worker,
            index: event.index,
            depth: event.depth,
            phase: event.phase,
            startMs: event.atMs,
            endMs: null,
            complete: false,
            work: 0,
            nodes: 0,
            activeMs: 0,
            cpuMs: 0,
            before: { work: w.work, nodes: w.nodes, activeMs: w.activeMs, cpuMs: w.cpuMs },
          });
        } else if (event.type === "worker" && event.accepted) {
          const w = workers[event.worker];
          phases[event.phase].activeMs += Math.max(0, event.activeMs - w.activeMs);
          phases[event.phase].cpuMs += Math.max(0, event.cpuMs - w.cpuMs);
          phaseWorkers[event.phase][event.worker].activeMs += Math.max(
            0,
            event.activeMs - w.activeMs,
          );
          phaseWorkers[event.phase][event.worker].cpuMs += Math.max(0, event.cpuMs - w.cpuMs);
          Object.assign(w, {
            activeMs: event.activeMs,
            cpuMs: event.cpuMs,
            work: event.work,
            nodes: event.nodes,
            rss: Math.max(w.rss, event.rss),
            restoreMs: event.restoreMs,
            createMs: event.createMs,
            taskInitMs: event.taskInitMs ?? w.taskInitMs,
            taskInitCpuMs: event.taskInitCpuMs ?? w.taskInitCpuMs,
            processCpuMs: event.processCpuMs ?? w.processCpuMs,
            restoreCpuMs: event.restoreCpuMs ?? w.restoreCpuMs,
            createCpuMs: event.createCpuMs ?? w.createCpuMs,
            transport: event.transport ?? w.transport,
          });
          const task = event.taskId === undefined ? undefined : tasks.get(event.taskId);
          if (task) {
            task.outcome = event.outcome;
            task.work = Math.max(0, event.work - task.before.work);
            task.nodes = Math.max(0, event.nodes - task.before.nodes);
            task.activeMs = Math.max(0, event.activeMs - task.before.activeMs);
            task.cpuMs = Math.max(0, event.cpuMs - task.before.cpuMs);
            if (event.barrier && !task.complete) {
              task.complete = true;
              task.endMs = event.atMs;
              phases[task.phase].completed++;
            }
          }
        }
      }
      if (iteration) intervals.push({ ...iteration, endMs: end, complete: false });
      for (const interval of intervals)
        phases[interval.phase].wallMs += Math.max(0, interval.endMs - interval.startMs);
      for (const task of tasks.values())
        phaseWorkers[task.phase][task.worker].assignedMs += (task.endMs ?? end) - task.startMs;
      for (const phase of ["broad", "deep", "adaptive"] as const) {
        const edges = [...tasks.values()]
          .filter((t) => t.phase === phase)
          .flatMap((t) => [
            { at: t.startMs, delta: 1 },
            { at: t.endMs ?? end, delta: -1 },
          ])
          .sort((a, b) => a.at - b.at || a.delta - b.delta);
        let count = 0,
          previous = edges[0]?.at ?? 0;
        for (const edge of edges) {
          phases[phase].concurrencyAreaMs += (edge.at - previous) * count;
          count += edge.delta;
          previous = edge.at;
          phases[phase].peakConcurrent = Math.max(phases[phase].peakConcurrent, count);
        }
      }
      const ipc = rows.filter(
        (e): e is Extract<StudyParallelEvent, { type: "ipc" }> => e.type === "ipc",
      );
      const parent = rows.filter(
        (e): e is Extract<StudyParallelEvent, { type: "parent" }> => e.type === "parent",
      );
      const sum = (xs: readonly any[], key: string) => xs.reduce((n, x) => n + x[key], 0);
      return {
        threads,
        eventCount: rows.length,
        phases: Object.fromEntries(
          Object.entries(phases).map(([key, p]) => [
            key,
            {
              ...p,
              sampledActiveShare: p.wallMs ? p.activeMs / (p.wallMs * threads) : null,
              averageConcurrent: p.wallMs ? p.concurrencyAreaMs / p.wallMs : null,
              assignedWaitMs: Math.max(0, p.wallMs * threads - p.concurrencyAreaMs),
              workers: phaseWorkers[key as Phase].map((w) => ({
                ...w,
                assignedWaitMs: Math.max(0, p.wallMs - w.assignedMs),
                sampledNonActiveMs: Math.max(0, p.wallMs - w.activeMs),
              })),
            },
          ]),
        ),
        workers,
        tasks: [...tasks.values()].map(({ before, ...t }) => {
          void before;
          return { ...t, wallMs: (t.endMs ?? end) - t.startMs };
        }),
        iterations: intervals.map((i) => {
          const ts = [...tasks.values()].filter(
            (t) =>
              t.phase === i.phase &&
              t.depth === i.depth &&
              t.startMs >= i.startMs &&
              t.startMs < i.endMs,
          );
          const roots = [...new Set(ts.filter((t) => t.role === "root").map((t) => t.index))].map(
            (index) => {
              const parts = ts.filter((t) => t.index === index);
              const started = Math.min(
                ...parts.filter((t) => t.role === "root").map((t) => t.startMs),
              );
              const finished = parts.find(
                (t) => t.complete && t.role !== "subtree" && t.outcome !== "split",
              );
              return {
                index,
                startMs: started,
                endMs: finished?.endMs ?? null,
                complete: !!finished,
                wallMs: (finished?.endMs ?? i.endMs) - started,
                work: parts.reduce((n, t) => n + t.work, 0),
                nodes: parts.reduce((n, t) => n + t.nodes, 0),
                activeMs: parts.reduce((n, t) => n + t.activeMs, 0),
                cpuMs: parts.reduce((n, t) => n + t.cpuMs, 0),
              };
            },
          );
          const ends = roots
            .filter((t) => t.complete)
            .map((t) => t.endMs!)
            .sort((a, b) => a - b);
          return {
            ...i,
            tasks: ts.length,
            roots,
            tailWaitMs: ends.length > 1 ? ends.at(-1)! - ends.at(-2)! : null,
            longestRootMs: roots.length ? Math.max(...roots.map((t) => t.wallMs)) : null,
          };
        }),
        ipc: Object.fromEntries(
          (["send", "receive"] as const).map((direction) => {
            const xs = ipc.filter((e) => e.direction === direction);
            return [
              direction,
              {
                count: xs.length,
                jsonBytes: sum(xs, "jsonBytes"),
                sizingMs: sum(xs, "sizingMs"),
                callMs: sum(xs, "callMs"),
              },
            ];
          }),
        ),
        parent: Object.fromEntries(
          (["dispatch", "merge"] as const).map((operation) => {
            const xs = parent.filter((e) => e.operation === operation);
            return [
              operation,
              { calls: xs.length, wallMs: sum(xs, "wallMs"), cpuMs: sum(xs, "cpuMs") },
            ];
          }),
        ),
        limitations:
          "JSON payload sizes are logical bytes, not Bun wire bytes. Receive time excludes native deserialization. CPU, wall and overlapping timers are separate. Latest worker samples may omit final send/unfinished work.",
      };
    },
  };
}
