import { listDurableObjectIds } from "cloudflare:test";
import { env } from "cloudflare:workers";

export async function unusedRoomId(): Promise<string> {
  const rooms = env.GAME_ROOM;
  // 共有 D1 の後片づけで索引が消えても、DO のルーム状態は残ります。
  const existing = new Set((await listDurableObjectIds(rooms)).map(String));
  for (let number = 0; number < 100_000; number++) {
    const id = String(number).padStart(5, "0");
    if (!existing.has(rooms.idFromName(id).toString())) return id;
  }
  throw new Error("テスト用の空きルーム番号がありません。");
}
