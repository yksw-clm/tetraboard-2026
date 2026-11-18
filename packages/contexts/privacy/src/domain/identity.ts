export const retiredName = "退会したプレイヤー";

export function redactRetiredParticipants<
  T extends {
    participants: { id?: string; name: string; accountId?: string | null; retired?: true }[];
    profileRatings?: Record<string, unknown>;
  },
>(record: T, retiredPlayers: ReadonlySet<string>, deleted: ReadonlySet<string>): T {
  if (!deleted.size && !retiredPlayers.size && !record.participants.some((p) => p.retired))
    return record;
  return {
    ...record,
    ...(record.profileRatings
      ? {
          profileRatings: Object.fromEntries(
            Object.entries(record.profileRatings).filter(
              ([id]) =>
                !record.participants.some(
                  (p) =>
                    p.id === id &&
                    (p.retired ||
                      retiredPlayers.has(id) ||
                      (p.accountId && deleted.has(p.accountId))),
                ),
            ),
          ),
        }
      : {}),
    participants: record.participants.map((p) =>
      (p.accountId && deleted.has(p.accountId)) || (p.id && retiredPlayers.has(p.id))
        ? { ...p, accountId: null, name: retiredName, retired: true }
        : p,
    ),
  };
}
