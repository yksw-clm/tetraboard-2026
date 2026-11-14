import type { Subprocess } from "bun";
import type { ServiceCommand, ServiceState } from "../src/serviceProtocol";

export class ServiceManager {
  private child: Subprocess<"ignore", "pipe", number> | null = null;
  private closing = false;
  constructor(
    private config: {
      executable: string;
      token: string;
      logFd: number;
      port?: number;
    },
  ) {}

  async status(): Promise<ServiceState> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null)
      return "running";
    this.child = null;
    try {
      const socket = await Bun.connect({
        hostname: "127.0.0.1",
        port: this.config.port ?? 3002,
        socket: {
          data() {},
          open(socket) {
            socket.end();
          },
          close() {},
          error() {},
        },
      });
      socket.end();
      return "external";
    } catch {
      return "stopped";
    }
  }

  async execute(command: ServiceCommand): Promise<ServiceState> {
    if (command === "status") return this.status();
    if (command === "stop") {
      if ((await this.status()) === "external")
        throw Error("手動で起動されたAIです。起動した端末で停止してください");
      await this.stop();
      return this.status();
    }
    if (command === "restart") {
      if ((await this.status()) === "external")
        throw Error("手動で起動されたAIです。起動した端末で停止してください");
      await this.stop();
    }
    const state = await this.status();
    if (this.closing) throw Error("補助プログラムを終了しています");
    if (state === "running") return state;
    if (state === "external")
      throw Error("ポート3002は既に使用中です。手動AIを端末で停止してください");
    const child = Bun.spawn([this.config.executable], {
      env: { ...process.env, AI_LOCAL_TOKEN: this.config.token },
      stdin: "ignore",
      stdout: "pipe",
      stderr: this.config.logFd,
    });
    this.child = child;
    const reader = child.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = (async () => {
        let line = "";
        while (line.length < 4096) {
          const chunk = await reader.read();
          if (chunk.done) throw Error("AIを起動できませんでした。service.logを確認してください");
          line += new TextDecoder().decode(chunk.value);
          if (line.includes("\n")) {
            const marker = JSON.parse(line.split("\n")[0]);
            if (
              marker.service !== "local-analysis" ||
              marker.listen !== `127.0.0.1:${this.config.port ?? 3002}`
            )
              throw Error("AIの起動応答が一致しません");
            return;
          }
        }
        throw Error("AIの起動応答が不正です");
      })();
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("AIの起動が時間切れになりました")), 5000);
        }),
      ]);
      // AIの標準出力はNative Messagingの応答へ混ぜません。
      void (async () => {
        while (!(await reader.read()).done) {
          /* 出力を排出します。 */
        }
      })().catch(() => {});
      return "running";
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    child.kill("SIGINT");
    try {
      await Promise.race([
        child.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 2000);
        }),
      ]);
      await child.exited;
    } finally {
      clearTimeout(timer);
      if (this.child === child) this.child = null;
    }
  }

  async close() {
    this.closing = true;
    await this.stop();
  }
}
