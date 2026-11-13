import { openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { nativeRequestSchema } from "../src/serviceProtocol";
import { encodeMessage, NativeFrames } from "./framing";
import { ServiceManager } from "./serviceManager";

export const nativeConfigSchema = z
  .object({
    version: z.literal(1),
    origin: z.string().regex(/^chrome-extension:\/\/[a-p]{32}\/$/),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

async function main() {
  const directory = dirname(process.execPath);
  const config = nativeConfigSchema.parse(
    await Bun.file(join(directory, "native-config.json")).json(),
  );
  if (process.argv[2] !== config.origin) throw Error("Unauthorized extension origin");
  const logFd = openSync(join(directory, "service.log"), "a", 0o600);
  const manager = new ServiceManager({
    executable: join(directory, "tetraboard-ai-local"),
    token: config.token,
    logFd,
  });
  let closing = false;
  const shutdown = async () => {
    closing = true;
    await manager.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  const frames = new NativeFrames();
  try {
    for await (const chunk of Bun.stdin.stream()) {
      for (const message of frames.push(chunk)) {
        const request = nativeRequestSchema.parse(message);
        try {
          const state = await manager.execute(request.command);
          if (closing) return;
          await Bun.write(
            Bun.stdout,
            encodeMessage({
              id: request.id,
              protocol_version: 1,
              ok: true,
              state,
              ...(state === "external" ? {} : { token: config.token }),
            }),
          );
        } catch (error) {
          await Bun.write(
            Bun.stdout,
            encodeMessage({
              id: request.id,
              protocol_version: 1,
              ok: false,
              error: error instanceof Error ? error.message : "AIの操作に失敗しました",
            }),
          );
        }
      }
    }
    frames.finish();
  } finally {
    await shutdown();
    closeSync(logFd);
  }
}

if (import.meta.main) {
  main().catch(() => {
    console.error("TetraBoard native helper failed. Re-run setup:native.");
    process.exitCode = 1;
  });
}
