import { expect, test } from "bun:test";
import { workerSqlWrites } from "./sqlWrites";

test("room_index への書き込みは索引の発行・閉鎖と退会時の伏せ字に集約する", () => {
  const writes = workerSqlWrites.filter(({ table }) => table === "room_index");
  expect(writes.map(({ file, operation }) => `${operation} ${file}`).sort()).toEqual([
    "INSERT rooms/roomIndex.ts",
    "UPDATE adapters/room/indexDeletion.ts",
    "UPDATE adapters/room/indexDeletion.ts",
    "UPDATE adapters/room/indexJob.ts",
  ]);
});
