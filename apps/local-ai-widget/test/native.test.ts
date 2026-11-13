import { expect, test } from "bun:test";
import { mkdtemp, chmod, rm, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeFrames, encodeMessage } from "../native/framing";
import { nativeConfigSchema } from "../native/host";
import { ServiceManager } from "../native/serviceManager";
import { createNativeClient } from "../src/nativeClient";
import { extensionIdForPath, readLocalToken } from "../scripts/installation";

test("Native framingは分割・連結を復元し、過大・不完全・不正JSONを拒否する", () => {
  const first = encodeMessage({ command: "status", text: "将棋" });
  const second = encodeMessage({ command: "stop" });
  const frames = new NativeFrames();
  expect(frames.push(first.slice(0, 3))).toEqual([]);
  expect(frames.push(first.slice(3, 6))).toEqual([]);
  expect(frames.push(new Uint8Array([...first.slice(6), ...second]))).toEqual([
    { command: "status", text: "将棋" },
    { command: "stop" },
  ]);
  frames.finish();
  expect(() => new NativeFrames().push(new Uint8Array([255, 255, 255, 255]))).toThrow();
  const truncated = new NativeFrames();
  truncated.push(first.slice(0, -1));
  expect(() => truncated.finish()).toThrow();
  const invalid = encodeMessage(null);
  invalid[4] = 123;
  expect(() => new NativeFrames().push(invalid)).toThrow();
});

function nativeHarness() {
  let onMessage: (value: unknown) => void = () => {};
  let onDisconnect: () => void = () => {};
  let connections = 0;
  const messages: { id: string; command: string }[] = [];
  const runtime = {
    connectNative: () => {
      connections++;
      return {
        onMessage: {
          addListener: (cb: typeof onMessage) => {
            onMessage = cb;
          },
        },
        onDisconnect: {
          addListener: (cb: typeof onDisconnect) => {
            onDisconnect = cb;
          },
        },
        disconnect: () => {
          onDisconnect();
        },
        postMessage: (message: (typeof messages)[number]) => {
          messages.push(message);
        },
      };
    },
  } as unknown as typeof chrome.runtime;
  return {
    client: createNativeClient(runtime),
    messages,
    reply: (value: unknown) => onMessage(value),
    disconnect: () => onDisconnect(),
    get connections() {
      return connections;
    },
  };
}
test("Native clientは同じ接続で要求IDを照合し、切断後は再接続できる", async () => {
  const h = nativeHarness();
  const status = h.client("status"),
    start = h.client("start");
  expect(h.connections).toBe(1);
  h.reply({
    id: h.messages[1].id,
    protocol_version: 1,
    ok: true,
    state: "running",
    token: "a".repeat(64),
  });
  h.reply({ id: h.messages[0].id, protocol_version: 1, ok: true, state: "stopped" });
  expect(await start).toMatchObject({ state: "running" });
  expect(await status).toMatchObject({ state: "stopped" });
  const pending = h.client("stop");
  h.disconnect();
  await expect(pending).rejects.toThrow("setup:native");
  const reconnected = h.client("status");
  expect(h.connections).toBe(2);
  h.reply({ id: h.messages[3].id, protocol_version: 1, ok: true, state: "stopped" });
  await reconnected;
});
test("Native clientは不正な応答を要求の成功にしない", async () => {
  const h = nativeHarness();
  const pending = h.client("start");
  h.reply({ id: h.messages[0].id, protocol_version: 99, ok: true, state: "running" });
  await expect(pending).rejects.toThrow("setup:native");
});

test("登録IDはChromeのパスhashに一致し、設定には固定originと秘密値だけを許す", () => {
  expect(extensionIdForPath("/tmp/tetraboard-extension")).toBe("iddfoaahkojagkcoolglicnphfhmpbbf");
  expect(readLocalToken(`OTHER=x\nAI_LOCAL_TOKEN=${"a".repeat(64)}\n`)).toBe("a".repeat(64));
  expect(() => readLocalToken("AI_LOCAL_TOKEN=bad")).toThrow();
  const config = {
    version: 1,
    origin: `chrome-extension://${"a".repeat(32)}/`,
    token: "a".repeat(64),
  };
  expect(nativeConfigSchema.safeParse(config).success).toBe(true);
  expect(
    nativeConfigSchema.safeParse({ ...config, origin: "https://tetraboard.net/" }).success,
  ).toBe(false);
  expect(nativeConfigSchema.safeParse({ ...config, command: "sh" }).success).toBe(false);
});

test("補助プログラムは自分のAIだけを起動・停止・再起動し、他のlistenerは終了しない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-manager-"));
  const log = await open(join(directory, "service.log"), "a", 0o600);
  const external = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {},
      open(socket) {
        socket.end();
      },
    },
  });
  const port = external.port;
  const executable = join(directory, "ai");
  await writeFile(
    executable,
    `#!/usr/bin/env bun\nconst server = Bun.listen({hostname: "127.0.0.1", port: ${port}, socket: {data() {}, open(socket) {socket.end();}}});\nconsole.log(JSON.stringify({listen: "127.0.0.1:${port}", service: "local-analysis"}));\nprocess.on("SIGINT", () => {server.stop(true); process.exit(0);});\n`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  const manager = new ServiceManager({ executable, token: "a".repeat(64), logFd: log.fd, port });
  try {
    expect(await manager.status()).toBe("external");
    for (const command of ["start", "stop", "restart"] as const)
      await expect(manager.execute(command)).rejects.toThrow();
    expect(await manager.status()).toBe("external");
    external.stop(true);
    expect(await manager.status()).toBe("stopped");
    expect(await manager.execute("start")).toBe("running");
    expect(await manager.execute("start")).toBe("running");
    expect(await manager.execute("restart")).toBe("running");
    expect(await manager.execute("stop")).toBe("stopped");
    expect(await manager.execute("stop")).toBe("stopped");
    await writeFile(executable, "#!/usr/bin/env bun\nprocess.exit(1);\n");
    await expect(manager.execute("start")).rejects.toThrow("起動できません");
    expect(await manager.status()).toBe("stopped");
  } finally {
    external.stop(true);
    await manager.stop();
    await log.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
