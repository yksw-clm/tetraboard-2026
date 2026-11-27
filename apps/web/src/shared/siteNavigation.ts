import { parseBoardPostNumber } from "@tetraboard/protocol/board";

export const boardPagePathPattern =
  /^\/(?:games\/([^/]+)\/posts\/?(?:\?match=[0-9a-fA-F-]+&position=\d+)?|posts\/([^/]+)\/?)$/;

export function matchedBoardPostNumber(pathname: string, param: string | undefined) {
  return boardPagePathPattern.exec(pathname)?.[2] ? parseBoardPostNumber(param ?? "") : null;
}

export function isGameViewPath(path: string): boolean {
  return /^\/(?:rooms|matches)\/[^/]+\/?$|^\/account\/matches\/[^/]+\/?$/.test(path);
}
