import { z } from "zod";
import {
  detectFormations,
  formationAnalyzerId,
  formationAnalysisVersion,
  formationIds,
  sides,
  type FormationPosition,
  type Side,
} from "@tetraboard/four-shogi";

const ids = z
  .array(z.enum(formationIds))
  .max(16)
  .refine((values) => new Set(values).size === values.length);
export const shogiFormationUsageSchema = z.strictObject({
  analyzerId: z.literal(formationAnalyzerId),
  analysisVersion: z.literal(formationAnalysisVersion),
  rulesVersion: z.literal(1),
  bySide: z.strictObject({ south: ids, west: ids, north: ids, east: ids }),
});
export type ShogiFormationUsage = z.infer<typeof shogiFormationUsageSchema>;

export function emptyFormationUsage(): ShogiFormationUsage {
  return {
    analyzerId: formationAnalyzerId,
    analysisVersion: formationAnalysisVersion,
    rulesVersion: 1,
    bySide: { south: [], west: [], north: [], east: [] },
  };
}

/** 通知の有無によらず、本人の確定着手による新規成立だけを局内一度記録します。 */
export function recordFormationUsage(
  usage: ShogiFormationUsage,
  before: FormationPosition,
  after: FormationPosition,
  side: Side,
): ShogiFormationUsage {
  shogiFormationUsageSchema.parse(usage);
  const previous = new Set(detectFormations(before, side).map((entry) => entry.id));
  const used = new Set(usage.bySide[side]);
  for (const match of detectFormations(after, side))
    if (!previous.has(match.id)) used.add(match.id);
  return {
    ...usage,
    bySide: { ...usage.bySide, [side]: formationIds.filter((id) => used.has(id)) },
  };
}

export function isFormationMatchEligible(record: {
  settings: { mode: string };
  participants: readonly { kind: string }[];
}) {
  return (
    record.settings.mode === "singles" &&
    record.participants.length === sides.length &&
    record.participants.every((player) => player.kind === "human")
  );
}
