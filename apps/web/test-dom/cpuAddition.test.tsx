import { expect, test } from "bun:test";
import type { CpuLevel } from "@tetraboard/protocol";
import { useCpuAddition } from "../src/features/room/useCpuAddition";
import { profile } from "../test/fixtures/account";
import { membership, playerIds, waitingRoom } from "../test/fixtures/rooms";
import { act, renderHook } from "./harness";

test("ログインhostの最初のCPUだけ確認し、取消・直接追加・全削除後の再確認を処理", () => {
  const room = waitingRoom();
  room.players = room.players.slice(0, 1);
  const levels: CpuLevel[] = [];
  const input = {
    room,
    membership,
    hostPlayerId: playerIds[0]!,
    canManageSettings: true,
    account: { user: profile, loading: false, error: null },
    addCpu: (level: CpuLevel) => levels.push(level),
  };
  const h = renderHook(useCpuAddition, input);
  act(() => h.current.request(2));
  expect(h.current.confirmation).toBe(2);
  expect(levels).toHaveLength(0);
  act(() => h.current.cancel());
  expect(levels).toHaveLength(0);
  act(() => h.current.request(1));
  act(() => h.current.confirm());
  expect(levels).toEqual([1]);
  expect(h.current.confirmation).toBeNull();
  const cpu = {
    id: playerIds[1]!,
    name: "CPU Lv2",
    kind: "cpu" as const,
    level: 2 as const,
    ready: true as const,
    color: null,
    reconnectDeadline: null,
  };
  h.rerender({ ...input, room: { ...room, players: [...room.players, cpu] } });
  act(() => h.current.request(2));
  expect(levels).toEqual([1, 2]);
  h.rerender(input);
  act(() => h.current.request(2));
  expect(h.current.confirmation).toBe(2);
});
test("確認中に満席・host喪失・開始・認証待ち/失敗へ変化したら追加しない", () => {
  const room = waitingRoom();
  room.players = room.players.slice(0, 1);
  let added = 0;
  const input = {
    room,
    membership,
    hostPlayerId: playerIds[0]!,
    canManageSettings: true,
    account: { user: profile, loading: false, error: null as string | null },
    addCpu: () => {
      added++;
    },
  };
  for (const next of [
    { room: waitingRoom() },
    { hostPlayerId: playerIds[1]! },
    { canManageSettings: false },
    { account: { ...input.account, loading: true } },
    { account: { ...input.account, error: "failed" } },
  ]) {
    const h = renderHook(useCpuAddition, input);
    act(() => h.current.request(1));
    expect(h.current.confirmation).toBe(1);
    h.rerender({ ...input, ...next });
    expect(h.current.confirmation).toBeNull();
    act(() => h.current.confirm());
    expect(added).toBe(0);
    h.unmount();
  }
  const guest = renderHook(useCpuAddition, {
    ...input,
    account: { user: null, loading: false, error: null },
  });
  act(() => guest.current.request(2));
  expect(added).toBe(1);
  expect(guest.current.confirmation).toBeNull();
});
