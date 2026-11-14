import { test, expect } from "bun:test";
import { Api } from "../src/api";
import { LocalAi } from "../src/ai";
import { turnFor } from "../src/game";
import { GameFixture, ids } from "../test/fixtures";
import { getFourShogiAnalysisReplayContract } from "@tetraboard/protocol";

test("実Rustの4プロセスが18秒の並行探索と取消を行い、3002の共有枠を使わない", async () => {
  const ais = Array.from({ length: 4 }, () => new LocalAi());
  const aborts = ais.map(() => new AbortController());
  const candidates = [0, 0, 0, 0];
  const failures: unknown[] = [];
  const tasks: Promise<void>[] = [];
  const sample = async () => {
    const child = Bun.spawn(["/bin/ps", "-axo", "pid=,ppid=,rss=,pcpu="], { stdout: "pipe" });
    const text = await new Response(child.stdout).text();
    await child.exited;
    const rows = text
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((row) => row[1] === process.pid && row[0] !== child.pid);
    expect(rows).toHaveLength(4);
    console.log(
      JSON.stringify({
        aiProcesses: rows.length,
        rssMiB: Math.round(rows.reduce((sum, row) => sum + row[2], 0) / 1024),
        cpuPercent: Math.round(rows.reduce((sum, row) => sum + row[3], 0)),
      }),
    );
  };
  try {
    for (let i = 0; i < 4; i++) {
      const f = new GameFixture(i < 2 ? "four-shogi" : "four-reversi", i !== 1);
      ids.forEach((_, j) => f.members.add(j));
      f.start();
      const room = f.room();
      const turn = turnFor(
        {
          type: "room.snapshot",
          room,
          serverNowMs: Date.now(),
          presence: { hostPlayerId: ids[0], connectedPlayerIds: ids },
        },
        ids[0],
        performance.now(),
      )!;
      const page = {
        instanceId: room.instanceId,
        roundId: "roundId" in room ? room.roundId : null,
        positionRevision: "positionRevision" in room ? room.positionRevision : 0,
        rulesVersion: 1,
        initial: { mode: "singles", threePlayerAttackProhibited: i !== 1 },
        events: [],
        eventCount: 0,
        nextCursor: null,
      };
      if (i < 2) getFourShogiAnalysisReplayContract.response.parse(page);
      const api = new Api(
        "http://localhost:8787",
        { cookie: "test", identity: ids[0] },
        async () => {},
        async () => Response.json(page),
      );
      tasks.push(
        ais[i]
          .watch(turn, api, aborts[i].signal, () => {
            candidates[i]++;
          })
          .catch((error) => {
            if (!aborts[i].signal.aborted) failures.push(error);
          }),
      );
    }
    await Bun.sleep(5000);
    await sample();
    await Bun.sleep(13000);
    await sample();
    expect(failures).toEqual([]);
    expect(candidates.every((count) => count > 1)).toBe(true);
  } finally {
    aborts.forEach((abort) => abort.abort());
    await Promise.allSettled(tasks);
    await Promise.all(ais.map((ai) => ai.close()));
  }
}, 30000);
