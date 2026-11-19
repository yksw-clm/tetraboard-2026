import { expect, test } from "vitest";
import { unusedRoomId } from "./unusedRoomId";

test("DO を作る前に複数のルーム番号を採番しても重複しない", async () => {
  const ids = await Promise.all([unusedRoomId(), unusedRoomId()]);

  expect(new Set(ids).size).toBe(ids.length);
});
