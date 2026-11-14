import { usageDataPoint, type UsageEvent } from "./events";

export interface UsageEventWriter {
  write(event: UsageEvent): void;
}

// 処理ごとに作り直し、DOの生存期間を通して件数を制限しないようにします。
export function createUsageEventWriter(
  binding?: Pick<AnalyticsEngineDataset, "writeDataPoint">,
): UsageEventWriter {
  let written = 0;
  return {
    write(event) {
      if (!binding || written >= 250) return;
      written++;
      try {
        binding.writeDataPoint(usageDataPoint(event));
      } catch {
        console.warn("Usage event write failed");
      }
    },
  };
}
