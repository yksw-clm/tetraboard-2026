import { expect, test } from "bun:test";
import { processMetrics } from "../scripts/processMetrics";

test("実プロセスのCPU時間とメモリをJSONへ保存できる", async () => {
  const child = Bun.spawn([process.execPath, "-e", "let n=0;for(let i=0;i<100000;i++)n+=i;"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await child.exited).toBe(0);
  const metrics = processMetrics(child.resourceUsage());
  expect(metrics).not.toBeNull();
  expect(metrics!.cpu_total_us).toBeGreaterThanOrEqual(0);
  expect(metrics!.max_rss_bytes).toBeGreaterThan(0);
  expect(JSON.parse(JSON.stringify(metrics))).toEqual(metrics);
});
