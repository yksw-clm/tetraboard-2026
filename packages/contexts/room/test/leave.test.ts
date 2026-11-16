import { expect, test } from "bun:test";
import { leaveRoom } from "../src";
import { MemoryPorts, now, playing } from "./memoryPorts";

test("待機のホスト退室は、退室ログ、ルーム配信、昇格資格、本人切断の順に返す", () => {
  const m = new MemoryPorts();
  m.addGuest();
  const result = m.run((op) => leaveRoom(op, "host-token"));
  expect(result.value.status).toBe("left");
  expect(result.effects).toEqual([
    { type: "chatChanged" },
    { type: "broadcastRoom", room: m.room! },
    { type: "sendMembership", tokenHash: "guest-token" },
    { type: "closeSockets", tokenHash: "host-token" },
  ]);
});

test("待機の最後の人間の退室は全接続を閉じてから本人を閉じる", () => {
  const m = new MemoryPorts();
  const result = m.run((op) => leaveRoom(op, "host-token"));
  expect(result.value).toEqual({ status: "left", room: null });
  expect(result.effects.map((e) => e.type)).toEqual([
    "chatChanged",
    "usage",
    "closeSockets",
    "closeSockets",
  ]);
});

test.each(["not_found", "time_expired", "unauthorized"] as const)("退室の拒否: %s", (status) => {
  const m = new MemoryPorts();
  if (status === "not_found") m.room = null;
  if (status === "time_expired")
    m.room = { ...playing(), clock: { ...playing().clock, turnExpiresAt: now } };
  if (status === "unauthorized") m.memberships.clear();
  const result = m.run((op) => leaveRoom(op, "host-token"));
  expect(result.value.status).toBe(status);
  expect(result.effects).toEqual([]);
  expect(m.calls).toEqual([]);
});

test("対局中の退室は準備して資格を解放してからゲームを進行し後処理を保存する", () => {
  const m = new MemoryPorts();
  m.addGuest();
  m.room = playing();
  const result = m.run((op) => leaveRoom(op, "host-token"));
  expect(result.value.status).toBe("left");
  expect(m.memberships.has("host-token")).toBe(false);
  expect(m.released).toEqual([["host", false]]);
  expect(m.calls).toEqual([
    "deleteIdentity:host",
    "release:host:false",
    "prepareLeave",
    "leave",
    "afterLeave",
    "saveRoom",
  ]);
  expect(result.effects).toEqual([
    { type: "chatChanged" },
    { type: "broadcastRoom", room: m.room! },
    { type: "closeSockets", tokenHash: "host-token" },
  ]);
});

test("大会待機の退室は除外を記録して大会ルームを閉じる", () => {
  const m = new MemoryPorts();
  m.addGuest();
  m.tournamentWaiting = true;
  const result = m.run((op) => leaveRoom(op, "host-token"));
  expect(result.value).toEqual({ status: "left", room: null });
  expect(m.calls).toContain("closeReservations");
  expect(m.released).toEqual([
    ["host", true],
    ["guest", true],
  ]);
  expect(result.effects.map((e) => e.type)).toEqual(["usage", "closeSockets", "closeSockets"]);
});
