import { leaveRoomContract, reportContract, viewerContract } from "@tetraboard/protocol";

export { fetchRoom } from "../../shared/roomAccess";

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
