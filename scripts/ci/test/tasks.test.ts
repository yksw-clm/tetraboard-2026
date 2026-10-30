import { expect, test } from "bun:test";
import { runTasks } from "../tasks";

test("子プロセスの失敗を成功にせず、開始済みの検証は回収する", async () => {
  const results = runTasks([
    { name: "runner-failure-fixture", command: ["bun", "-e", "process.exit(7)"], record: false },
    {
      name: "runner-success-fixture",
      command: ["bun", "-e", "console.log('completed')"],
      record: false,
    },
  ]);
  await expect(results).rejects.toThrow("exit 7");
  await expect(runTasks([], 0)).rejects.toThrow("並列数");
});
