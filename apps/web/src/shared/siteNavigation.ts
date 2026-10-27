export function isGameViewPath(path: string): boolean {
  return /^\/(?:rooms|matches)\/[^/]+\/?$|^\/account\/matches\/[^/]+\/?$/.test(path);
}
