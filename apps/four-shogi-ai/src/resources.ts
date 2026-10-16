import { readFileSync } from "node:fs";
export function serviceRss(pids: number[]) {
  let bytes = process.memoryUsage().rss;
  if (process.platform === "linux")
    for (const pid of pids) {
      try {
        bytes +=
          Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) *
          1024;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  else if (process.platform === "darwin" && pids.length) {
    const sample = Bun.spawnSync(["ps", "-o", "rss=", "-p", pids.join(",")]);
    if (sample.exitCode !== 0 && sample.exitCode !== 1) throw new Error("rss_unavailable");
    for (const value of sample.stdout.toString().trim().split(/\s+/))
      if (value) bytes += Number(value) * 1024;
  } else if (process.platform !== "darwin") throw new Error("unsupported_platform");
  if (!Number.isFinite(bytes)) throw new Error("rss_unavailable");
  return bytes;
}
