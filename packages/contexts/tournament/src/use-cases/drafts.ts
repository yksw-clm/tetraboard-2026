import type { TournamentInput } from "@tetraboard/protocol";
import type { TournamentDraftStore } from "./ports";
export async function createDraft(
  store: TournamentDraftStore,
  input: TournamentInput,
  clock: { id(): string; now(): number },
) {
  const key = clock.id(),
    now = clock.now();
  await store.create(input, key, now);
  return key;
}
export function updateDraft(
  store: TournamentDraftStore,
  key: string,
  input: TournamentInput,
  version: number,
  now: () => number,
) {
  return store.update(key, input, version, now());
}
