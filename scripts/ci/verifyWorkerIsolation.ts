import { runTasks } from "./tasks";

const waiting: ((response: Response) => void)[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    return new Promise<Response>((resolve) => {
      waiting.push(resolve);
      if (waiting.length === 2)
        for (const done of waiting.splice(0)) done(new Response(null, { status: 204 }));
    });
  },
});
try {
  await runTasks(
    [1, 2].map((part) => ({
      name: `isolation-probe-${part}`,
      command: [
        "bun",
        "run",
        "--cwd",
        "apps/worker",
        "test",
        "--config",
        "vitest.isolation.config.mts",
      ],
      env: { CI_ISOLATION_BARRIER: `http://127.0.0.1:${server.port}/` },
    })),
  );
} finally {
  await server.stop(true);
}
