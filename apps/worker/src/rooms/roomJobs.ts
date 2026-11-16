type AlarmEvents = { sync(): Promise<void>; afterFlush(): Promise<void> };

type RoomJobOptions<T, R> = {
  pending(): Iterable<T>;
  retryAt(job: T): number | null;
  execute(job: T): Promise<R>;
  complete(job: T, result: R): void;
  retry(job: T, retryAtMs: number, error: unknown): void;
  mode?: "drain" | "snapshot" | "single";
  stopOnFailure?: boolean;
  syncWhenEmpty?: boolean;
  syncOnlyWhenDue?: boolean;
  canRun?(): boolean;
};

export class RoomJob<T, R = void> {
  running: Promise<void> | null = null;

  constructor(
    private readonly alarms: AlarmEvents,
    private readonly options: RoomJobOptions<T, R>,
  ) {}

  nextAlarmAt(): number | null {
    let next: number | null = null;
    for (const job of this.options.pending()) {
      const at = this.options.retryAt(job);
      if (at !== null && (next === null || at < next)) next = at;
    }
    return next;
  }

  flush(): Promise<void> {
    if (this.running) return this.running;
    if (this.options.canRun?.() === false) return Promise.resolve();
    const pending = [...this.options.pending()];
    if (this.options.syncOnlyWhenDue && !pending.some((job) => this.due(job)))
      return Promise.resolve();
    if (!pending.length && !this.options.syncWhenEmpty) return Promise.resolve();
    this.running = this.run(pending).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private due(job: T): boolean {
    const at = this.options.retryAt(job);
    return at !== null && at <= Date.now();
  }

  private async run(pending: T[]): Promise<void> {
    const mode = this.options.mode ?? "drain";
    for (;;) {
      const job = mode === "snapshot" ? pending.shift() : pending.find((entry) => this.due(entry));
      if (job === undefined) break;
      if (!this.due(job)) continue;
      try {
        await this.alarms.sync();
        const result = await this.options.execute(job);
        this.options.complete(job, result);
      } catch (error) {
        this.options.retry(job, Date.now() + 5_000, error);
        if (this.options.stopOnFailure !== false) break;
      }
      if (mode === "single") break;
      if (mode === "drain") pending = [...this.options.pending()];
    }
    await this.alarms.afterFlush();
  }
}
