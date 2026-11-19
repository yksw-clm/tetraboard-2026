import { listDurableObjectIds } from "cloudflare:test";
import { env } from "cloudflare:workers";

const issuedRoomIds = new Set<string>();

export async function createUnusedRoomIdAllocator() {
  const rooms = env.GAME_ROOM;
  // 共有 D1 の後片づけで索引が消えても、DO のルーム状態は残ります。
  const existing = new Set((await listDurableObjectIds(rooms)).map(String));
  let number = 0;
  return {
    next(): string {
      while (number < 100_000) {
        const id = String(number++).padStart(5, "0");
        if (issuedRoomIds.has(id) || existing.has(rooms.idFromName(id).toString())) continue;
        issuedRoomIds.add(id);
        return id;
      }
      throw new Error("テスト用の空きルーム番号がありません。");
    },
    exclude(id: string): void {
      existing.add(rooms.idFromName(id).toString());
    },
  };
}

export async function unusedRoomId(): Promise<string> {
  return (await createUnusedRoomIdAllocator()).next();
}
