import { boardAttachmentSchema, type BoardAttachment } from "@tetraboard/protocol/board";

export function readBoardAttachmentSearch(search: URLSearchParams) {
  const [matchId, ...matches] = search.getAll("match");
  const [position, ...positions] = search.getAll("position");
  if (!position || !/^\d+$/.test(position) || matches.length || positions.length) return null;
  const result = boardAttachmentSchema.safeParse({ matchId, position: Number(position) });
  return result.success ? result.data : null;
}

export function boardTimelineReturnPath(path: string, attachment: BoardAttachment | null) {
  return attachment ? `${path}?match=${attachment.matchId}&position=${attachment.position}` : path;
}
