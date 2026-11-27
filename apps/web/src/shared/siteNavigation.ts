export const boardPagePathPattern =
  /^\/(?:games\/([^/]+)\/posts\/?(?:\?match=[0-9a-fA-F-]+&position=\d+)?|posts\/([^/]+)\/?)$/;

export function isGameViewPath(path: string): boolean {
  return /^\/(?:rooms|matches)\/[^/]+\/?$|^\/account\/matches\/[^/]+\/?$/.test(path);
}
