import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairedSummary, promotionDecision } from "../bench/nightlyCompare";
import { NightlySupervisor } from "../bench/nightlyResources";
import { sides } from "../src/types";
test("独立16対応条件と戦術/実用予算が全部揃うまで昇格せず、未終局を補完しない", () => {
  const seeds = [48001, 48002, 48003, 48004];
  const games = seeds.flatMap((seed) =>
    sides.flatMap((seat) => [
      { seed, seat, generationId: "g000", status: "finished" as const, rank: 2, soleWin: false },
      {
        seed,
        seat,
        generationId: "candidate",
        status: "finished" as const,
        rank: 1,
        soleWin: true,
      },
    ]),
  );
  const summary = pairedSummary(games, seeds, "g000", "candidate");
  const gate = {
    qualified: true,
    criticalPassed: 40,
    criticalTotal: 40,
    knownPassed: 8,
    knownTotal: 8,
    resourcePassed: true,
    summary,
    timeBudgetMs: 5000,
    threads: 4,
  };
  expect(promotionDecision(gate).decision).toBe("promote");
  expect(promotionDecision({ ...gate, qualified: false }).decision).toBe("hold");
  expect(promotionDecision({ ...gate, knownPassed: 7 }).decision).toBe("hold");
  expect(promotionDecision({ ...gate, timeBudgetMs: 500 }).decision).toBe("hold");
  const incomplete = pairedSummary(games.slice(0, -1), seeds, "g000", "candidate");
  expect(incomplete.completedPairs).toBe(15);
  expect(promotionDecision({ ...gate, summary: incomplete }).decision).toBe("hold");
});
test("外側の期限でBun工程を回収し、失敗を完了として返さない", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-budget-"));
  try {
    const supervisor = new NightlySupervisor(
      { maxRunMs: 100, maxRssBytes: 2 * 1024 ** 3, hardRssBytes: 3 * 1024 ** 3, minFreeBytes: 1 },
      root,
      undefined,
      { readPressure: () => 1 },
    );
    await expect(
      supervisor.run(
        "deadline",
        [process.execPath, "-e", "setInterval(()=>{},1000)"],
        join(root, "log"),
        join(root, "usage.json"),
      ),
    ).rejects.toThrow();
    expect(supervisor.records).toHaveLength(1);
    expect(supervisor.records[0].exitCode).not.toBe(0);
    expect(supervisor.records[0].stopReason).toBe("time_limit");
    expect(supervisor.records[0].peakProcesses).toBeGreaterThanOrEqual(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
