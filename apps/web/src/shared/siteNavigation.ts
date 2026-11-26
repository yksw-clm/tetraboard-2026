export const boardPagePathPattern = /^\/(?:games\/([^/]+)\/posts|posts\/([^/]+))\/?$/;

export function isGameViewPath(path: string): boolean {
  return /^\/(?:rooms|matches)\/[^/]+\/?$|^\/account\/matches\/[^/]+\/?$/.test(path);
}
