import { createUsageEventWriter, type UsageEventWriter } from "./writer";
import type { UsageEvent } from "./events";

export class TransactionUsageEvents {
  private pending: UsageEvent[] | null = null;

  constructor(private readonly binding: () => AnalyticsEngineDataset | undefined) {}

  writer(): UsageEventWriter {
    if (!this.pending) return createUsageEventWriter(this.binding());
    const pending = this.pending;
    let written = 0;
    return {
      write(event) {
        if (written++ < 250) pending.push(event);
      },
    };
  }

  run<T>(transaction: () => T): T {
    const parent = this.pending;
    const pending: UsageEvent[] = [];
    this.pending = pending;
    let result: T;
    try {
      result = transaction();
    } finally {
      this.pending = parent;
    }
    if (parent) parent.push(...pending);
    else {
      const writer = createUsageEventWriter(this.binding());
      for (const event of pending) writer.write(event);
    }
    return result;
  }
}
