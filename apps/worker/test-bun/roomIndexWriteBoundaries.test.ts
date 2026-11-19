import { expect, test } from "bun:test";
import { workerSqlWrites } from "./sqlWrites";

test("room_index への書き込みは索引の発行・閉鎖・期限処理と退会時の伏せ字に集約する", () => {
  const writes = workerSqlWrites.filter(({ table }) => table === "room_index");
  expect(writes.map(({ file, operation }) => `${operation} ${file}`).sort()).toEqual([
    "DELETE rooms/roomIndexRetention.ts",
    "INSERT rooms/roomIndex.ts",
    "UPDATE adapters/room/indexDeletion.ts",
    "UPDATE adapters/room/indexDeletion.ts",
    "UPDATE adapters/room/indexJob.ts",
    "UPDATE rooms/roomIndexRetention.ts",
  ]);
});
