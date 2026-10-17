import { expect, test } from "bun:test";
import { aiJobRequestSchema } from "@tetraboard/protocol/four-shogi-ai";
import { config, request } from "./fixtures";
import { JobManager, type JobExecutor } from "../src/jobs";
import { createServiceHandler } from "../src/http";
const executor: JobExecutor = {
  ready: () => true,
  run: () => {},
  cancel: () => {},
  kill: () => {},
  close: async () => {},
};
function setup() {
  const entries: object[] = [];
  const manager = new JobManager(
    config,
    executor,
    request().serviceInstanceId,
    () => 0,
    () => crypto.randomUUID(),
    (e) => entries.push(e),
  );
  let shutdown = false;
  const handle = createServiceHandler(manager, () => {
    shutdown = true;
  });
  return { handle, entries, stopped: () => shutdown };
}
const json = (body: unknown, token = config.secret) => ({
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer " + token },
  body: JSON.stringify(body),
});
test("秘密を検証してから本文を読み、未認証の要求やログへ秘密・棋譜を出さない", async () => {
  const { handle, entries } = setup();
  let read = false;
  const stream = new ReadableStream(
    {
      pull() {
        read = true;
        throw new Error("must_not_read");
      },
    },
    { highWaterMark: 0 },
  );
  const response = await handle(
    new Request("http://local/v1/jobs", {
      method: "POST",
      body: stream,
      headers: { authorization: "Bearer wrong" },
      duplex: "half",
    } as RequestInit),
  );
  expect(response.status).toBe(401);
  expect(read).toBe(false);
  expect(await response.json()).toEqual({ error: "unauthenticated", retryAfterMs: 0 });
  expect(entries).toEqual([]);
});
test("任意パス・コマンド・余分な設定・過大本文・不正JSONを拒否する", async () => {
  const { handle } = setup();
  expect(
    (
      await handle(
        new Request(
          "http://local/v1/jobs",
          json({
            ...request(),
            position: { ...request().position, events: Array(2049).fill(null) },
          }),
        ),
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await handle(
        new Request(
          "http://local/v1/jobs",
          json({ ...request(), modelDirectory: "/secret/model" }),
        ),
      )
    ).status,
  ).toBe(400);
  expect(
    (await handle(new Request("http://local/v1/jobs", json("x".repeat(config.maxRequestBytes)))))
      .status,
  ).toBe(413);
  expect(
    (await handle(new Request("http://local/v1/jobs", { ...json(null), body: "{" }))).status,
  ).toBe(400);
  expect(
    aiJobRequestSchema.safeParse({
      ...request(),
      position: {
        ...request().position,
        initial: {
          ...request().position.initial,
          players: { south: "user@email.test", west: "west", north: "north", east: "east" },
        },
      },
    }).success,
  ).toBe(false);
});
test("実行中もhealth/取消/shutdownが応答し、他人や別起動の結果を返さない", async () => {
  const { handle, stopped, entries } = setup();
  const input = request();
  const accepted = await handle(new Request("http://local/v1/jobs", json(input)));
  expect(accepted.status).toBe(202);
  const job = (await accepted.json()) as { jobId: string };
  const headers = {
    authorization: "Bearer " + config.secret,
    "x-ai-principal": input.principal,
    "x-ai-instance": input.serviceInstanceId,
  };
  expect((await handle(new Request("http://local/v1/health", { headers }))).status).toBe(200);
  const path = "http://local/v1/jobs/" + job.jobId;
  expect(
    (await handle(new Request(path, { headers: { ...headers, "x-ai-principal": "d".repeat(64) } })))
      .status,
  ).toBe(404);
  expect((await handle(new Request(path, { method: "DELETE", headers }))).status).toBe(200);
  expect(
    (await handle(new Request("http://local/v1/shutdown", { method: "POST", headers }))).status,
  ).toBe(202);
  expect(stopped()).toBe(true);
  expect((await handle(new Request("http://local/v1/jobs", json(request(2))))).status).toBe(503);
  const logs = JSON.stringify(entries);
  expect(logs).not.toContain(config.secret);
  expect(logs).not.toContain(input.principal);
  expect(logs).not.toContain("threePlayerAttackProhibited");
});
