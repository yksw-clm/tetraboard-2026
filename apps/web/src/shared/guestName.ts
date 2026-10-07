import { joinRoomContract } from "@tetraboard/protocol";

const storageKey = "tetraboard:guest-name";

export function readGuestName(): string {
  try {
    const name = localStorage.getItem(storageKey);
    const parsed = joinRoomContract.request.safeParse({ name });
    return parsed.success ? (parsed.data.name ?? "") : "";
  } catch {
    return "";
  }
}

export function saveGuestName(name: string | undefined): void {
  if (name === undefined) return;
  const parsed = joinRoomContract.request.safeParse({ name });
  if (!parsed.success || parsed.data.name === undefined) return;
  try {
    localStorage.setItem(storageKey, parsed.data.name);
  } catch {
    // 名前を保存できなくても、作成・参加は継続します。
  }
}
