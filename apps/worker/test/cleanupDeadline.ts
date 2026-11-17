import { clearTimeout, setTimeout } from "node:timers";

// Vitestのhookより先に、待ちの内訳を付けて失敗させます。
export const cleanupTimeoutMs = 5_000;

export class CleanupDeadline {
  private readonly expiresAt: number;
  private failure: Error | undefined;
  private readonly waiting = new Map<symbol, () => string>();

  constructor(
    private readonly timeoutMs: number,
    private readonly describe: () => string,
  ) {
    this.expiresAt = performance.now() + timeoutMs;
  }

  check(): void {
    if (this.failure) throw this.failure;
    if (performance.now() >= this.expiresAt) throw this.expire();
  }

  private expire(): Error {
    if (!this.failure) {
      this.failure = new Error(
        `Durable Object cleanup timed out after ${this.timeoutMs}ms; ${this.describe()}; waiting: ${[
          ...this.waiting.values(),
        ]
          .map((describe) => describe())
          .join("; ")}`,
      );
      // RPCによる失敗報告も停止した場合に備え、workerdの出力にも残します。
      console.error(this.failure.message);
    }
    return this.failure;
  }

  async wait<T>(describe: () => string, action: () => Promise<T>): Promise<T> {
    const token = Symbol();
    this.waiting.set(token, describe);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.check();
      // タイマーはawaitするI/Oコンテキスト内に作り、別DOと共有しません。
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(this.expire()), this.expiresAt - performance.now());
      });
      const result = await Promise.race([action(), expired]);
      this.check();
      return result;
    } finally {
      clearTimeout(timer);
      this.waiting.delete(token);
    }
  }

  async yield(): Promise<void> {
    this.check();
    // 解決済みPromiseだけのループでも、期限タイマーとworkerdの時計を進めます。
    await this.wait(
      () => "cleanup loop yield",
      () => new Promise((resolve) => setTimeout(resolve, 0)),
    );
  }
}
