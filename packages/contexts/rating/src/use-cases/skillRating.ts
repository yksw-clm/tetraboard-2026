import { eligibleSkillMatch, type SkillMatch } from "../domain/skillMatch";
import { skillChanges } from "../domain/skillChanges";
import type { SkillGame } from "../domain/policy";
import type { SkillRatingStore } from "./ports";
export async function prepareSkillRating<Write>(
  store: SkillRatingStore<Write>,
  game: SkillGame,
  match: SkillMatch,
) {
  const eligible = eligibleSkillMatch(game, match);
  if (!eligible || (await store.applied(game, match.id))) return null;
  const ids = eligible.players.flatMap((p) => (p.kind === "human" ? [p.accountId] : []));
  const rows = await store.current(game, ids);
  if (rows.length !== ids.length) return null;
  return {
    write: store.changes(game, match.id, skillChanges(eligible.players, eligible.ranks, rows)),
    count: ids.length,
  };
}
export async function applySkillRating<Write>(
  store: SkillRatingStore<Write>,
  game: SkillGame,
  match: SkillMatch,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const prepared = await prepareSkillRating(store, game, match);
    if (!prepared || (await store.save(prepared.write)) === prepared.count) return;
  }
  throw Error("4人対局のレート更新を再試行してください");
}
