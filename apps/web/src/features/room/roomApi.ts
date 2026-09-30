import {
  getRoomContract,
  leaveRoomContract,
  reportContract,
  viewerContract,
} from "@tetraboard/protocol";

export async function fetchRoom(id: string, signal: AbortSignal) {
  const response = await fetch(`/api${getRoomContract.pathFor(id)}`, {
    method: getRoomContract.method,
    cache: "no-store",
    signal,
  });
  const body: unknown = await response.json();

  if (!response.ok) {
    if (!getRoomContract.error.safeParse(body).success) {
      throw new Response("ルーム情報の応答が不正です。", { status: 502 });
    }
    throw new Response(null, { status: response.status });
  }

  const room = getRoomContract.response.safeParse(body);
  if (!room.success || room.data.room.id !== id) {
    throw new Response("ルーム情報の応答が不正です。", { status: 502 });
  }
  return room.data;
}

export async function leaveRoom(id: string, token: string): Promise<void> {
  const response = await fetch(`/api${leaveRoomContract.pathFor(id)}`, {
    method: leaveRoomContract.method,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status !== 204 && response.status !== 401 && response.status !== 404) {
    throw new Error("Room leave failed");
  }
}

export async function issueViewerToken(id: string): Promise<string> {
  const response = await fetch(`/api${viewerContract.pathFor(id)}`, {
    method: viewerContract.method,
  });
  if (!response.ok) throw new Error("Viewer token failed");
  return viewerContract.response.parse(await response.json()).token;
}

export async function reportMessage(id: string, token: string, messageId: string): Promise<void> {
  const response = await fetch(`/api${reportContract.pathFor(id)}`, {
    method: reportContract.method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(reportContract.request.parse({ messageId })),
  });
  if (!response.ok) throw new Error("Report failed");
  reportContract.response.parse(await response.json());
}
