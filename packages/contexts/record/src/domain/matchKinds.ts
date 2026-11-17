import type { MatchKind } from "@tetraboard/protocol";
export function withMatchKind<T extends { id: string }>(
  match: T,
  kinds?: ReadonlyMap<string, MatchKind>,
) {
  return kinds ? { ...match, matchKind: kinds.get(match.id) ?? ("unknown" as const) } : match;
}
