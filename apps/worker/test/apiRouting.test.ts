import { exports } from "cloudflare:workers";
import { createRoomContract, getRoomContract, roomSocketContract } from "@tetraboard/protocol";
import { expect, test } from "vitest";

test("/api はJSON・認証・WebSocketを既存のルーム処理へ渡す", async () => {
  const base = "https://example.com/api";
  const health = await exports.default.fetch(new Request(`${base}/healthz`));
  expect(await health.json()).toEqual({ status: "ok" });
  const created = await exports.default.fetch(
    new Request(`${base}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "配信確認", mode: "singles", quickPlay: false }),
    }),
  );
  expect(created.status).toBe(201);
  const { room, membership } = createRoomContract.response.parse(await created.json());
  try {
    const response = await exports.default.fetch(new Request(`${base}/rooms/${room.id}`));
    expect(getRoomContract.response.parse(await response.json()).room.id).toBe(room.id);
    const me = await exports.default.fetch(
      new Request(`${base}/rooms/${room.id}/me`, {
        headers: { Authorization: `Bearer ${membership.token}` },
      }),
    );
    expect(me.status).toBe(200);
    const upgraded = await exports.default.fetch(
      new Request(`${base}/rooms/${room.id}/ws?instanceId=${room.instanceId}`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(upgraded.status).toBe(101);
    const socket = upgraded.webSocket!;
    socket.accept();
    try {
      const authenticated = new Promise<void>((resolve, reject) => {
        socket.addEventListener("message", (event) => {
          try {
            const message = roomSocketContract.message.parse(JSON.parse(String(event.data)));
            if (message.type === "room.authenticated") resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      socket.send(JSON.stringify({ type: "room.auth", token: membership.token }));
      await authenticated;
    } finally {
      socket.close();
    }
    const stale = await exports.default.fetch(
      new Request(`${base}/rooms/${room.id}/ws?instanceId=${crypto.randomUUID()}`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(stale.status).toBe(410);
  } finally {
    await exports.default.fetch(
      new Request(`${base}/rooms/${room.id}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${membership.token}` },
      }),
    );
  }
});

test("未知の /api は画面のHTMLではなく404を返す", async () => {
  const response = await exports.default.fetch(new Request("https://example.com/api/missing"));
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).not.toContain("text/html");
});
