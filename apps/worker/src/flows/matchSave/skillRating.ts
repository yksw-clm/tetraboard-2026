import { applySkillRating } from "@tetraboard/context-rating";
import { D1SkillRatingStore } from "../../adapters/rating/skillStore";
import type { MatchRecord } from "../../rooms/matchStore";
import type { ShogiMatchRecord } from "../../rooms/shogiMatchStore";
export function applyFourReversiRating(db: D1Database, record: Omit<MatchRecord, "replay">) {
  return applySkillRating(new D1SkillRatingStore(db), "four-reversi", {
    id: record.id,
    settings: record.settings,
    source: record.fourReversiRating,
    result: {
      mode: record.game.result.mode,
      standings:
        record.game.result.mode === "singles"
          ? record.game.result.standings.map((s) => ({ seat: s.color, rank: s.rank }))
          : [],
    },
    participants: record.participants.map((p) => ({ ...p, seat: p.color })),
  });
}
export function applyFourShogiRating(db: D1Database, record: ShogiMatchRecord) {
  return applySkillRating(new D1SkillRatingStore(db), "four-shogi", {
    id: record.id,
    settings: record.settings,
    source: record.fourShogiRating,
    result: {
      mode: record.game.result.mode,
      standings:
        record.game.result.mode === "singles"
          ? record.game.result.standings.map((s) => ({ seat: s.side, rank: s.rank }))
          : [],
    },
    participants: record.participants.map((p) => ({ ...p, seat: p.side })),
  });
}
