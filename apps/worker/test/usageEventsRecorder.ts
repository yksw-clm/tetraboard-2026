import { onTestFinished, vi } from "vitest";
import type { UsageEvent } from "../src/usageEvents/events";
import * as writers from "../src/usageEvents/writer";

export function recordUsageEvents(fail = false) {
  const events: UsageEvent[] = [];
  const create = writers.createUsageEventWriter;
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  vi.spyOn(writers, "createUsageEventWriter").mockImplementation(() => {
    const writer = create({
      writeDataPoint() {
        if (fail) throw new Error("unavailable");
      },
    });
    return {
      write(event) {
        events.push(structuredClone(event));
        writer.write(event);
      },
    };
  });
  return events;
}
