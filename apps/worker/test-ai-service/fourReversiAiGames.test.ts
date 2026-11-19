import { runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { getLegalMoves } from "@tetraboard/four-reversi";
import {
  fourReversiCpuJobKey,
  type FourReversiCpuJob,
} from "../src/adapters/room/games/four-reversi/progress";
import { FourReversiAiFixture } from "./fourReversiAiFixture";

const fixture = new FourReversiAiFixture();
const { cpuSetup, alarmWithProfile, completeGame, clock } = fixture;

test("四人リバーシの4局・12席を共有し、連続CPU手番を局ごとに1件ずつ処理する", async () => {
  const rooms = await Promise.all(Array.from({ length: 4 }, () => cpuSetup("singles", 2, true)));
  const fifth = await fixture.fixtures.create({
    game: "four-reversi",
    name: "次のホスト",
    quickPlay: true,
    cpuLevel: 1,
    mode: "singles",
  });
  const host = await fixture.fixtures.connect(fifth);
  host.send({ type: "room.game.start" });
  expect((await host.waitFor("room.error")).error).toBe("cpu_capacity_full");
  expect((await fixture.fixtures.snapshot(fifth.room.id)).room.status).toBe("waiting");

  const fetchSpy = vi.spyOn(globalThis, "fetch");
  // 初手を人間の次の色に固定しているため、各局でCPUが連続します。
  for (let turn = 0; turn < 2; turn++) {
    const positions = await Promise.all(rooms.map(({ read }) => read()));
    clock.now =
      Math.max(
        ...positions.map((room) => (room.status === "playing" ? room.clock.turnStartedAt : 0)),
      ) + 2000;
    await Promise.all(rooms.map(({ stub }) => alarmWithProfile(stub, { profile_id: "lv3-v1" })));
    const jobs = await Promise.all(
      rooms.map(({ stub }) =>
        runInDurableObject(stub, (_, ctx) =>
          ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey),
        ),
      ),
    );
    for (const [i, job] of jobs.entries()) {
      expect(job?.source).toBe("external");
      expect(getLegalMoves(positions[i]!.game!)).toContainEqual(job?.move);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(4 * (turn + 1));
    clock.now = Math.max(...jobs.map((job) => job!.applyAt));
    await Promise.all(rooms.map(({ stub }) => alarmWithProfile(stub)));
    const after = await Promise.all(rooms.map(({ read }) => read()));
    for (const [i, room] of after.entries())
      expect(room.game?.moveNumber).toBe(positions[i]!.game!.moveNumber + 1);
  }

  const released = rooms[0]!;
  const roomId = released.before.id;
  const member = await runInDurableObject(released.stub, (_, ctx) => {
    const player = released.before.players.find((p) => p.kind === "human")!;
    return ctx.storage.kv.get<string>(`player-token:${player.id}`)!;
  });
  expect(await released.stub.leaveRoom(member)).toBe("left");
  fixture.fixtures.forgetClosedRoom(roomId);
  await runInDurableObject(released.stub, (instance) => instance.alarm());
  host.send({ type: "room.game.start" });
  await host.waitFor("room.snapshot", (m) => m.room.status === "playing");
}, 12000);

for (const level of [1, 2])
  test(
    `実Rust Serviceと人間1人・CPU3人のLv${level}対局を終局まで進める`,
    () => completeGame(level),
    20000,
  );
