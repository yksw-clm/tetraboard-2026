import { afterEach, beforeEach } from "bun:test";

const aiDirectory = new URL("..", import.meta.url).pathname;

export function useLocalAiService() {
  const service = { url: "", token: "test-ai-service-token-at-least-32-characters" };
  let server: ReturnType<typeof Bun.spawn> | undefined;

  // Bunはtimeout時にbeforeAllで起動した子も終了するため、テスト間で共有しません。
  beforeEach(async () => {
    server = Bun.spawn(
      ["cargo", "run", "--release", "--quiet", "--locked", "-p", "tetraboard-ai-server"],
      {
        cwd: aiDirectory,
        env: {
          ...process.env,
          AI_SERVICE_TOKEN: service.token,
          AI_SERVICE_LISTEN: "127.0.0.1:0",
          AI_SERVICE_CONCURRENCY: "4",
        },
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    const child = server;
    void child.exited.then((code) =>
      console.error(
        `AI test service exited: pid=${child.pid} code=${code} signal=${child.signalCode}`,
      ),
    );
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    try {
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw Error(`AI Service did not start: exit=${await child.exited}`);
        text += new TextDecoder().decode(value);
        if (text.includes("\n")) break;
      }
      service.url = `http://${JSON.parse(text.split("\n")[0]).listen}`;
      console.error(`AI test service listening: pid=${child.pid} url=${service.url}`);
    } finally {
      reader.releaseLock();
    }
  }, 30000);

  afterEach(async () => {
    if (server?.exitCode === null) server.kill("SIGTERM");
    if (server) await server.exited;
    server = undefined;
  });
  return service;
}
