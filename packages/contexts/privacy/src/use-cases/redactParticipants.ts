import { redactRetiredParticipants } from "../domain/identity";

export interface ParticipantPrivacyReader {
  readCanonicalAccounts(guestIds: string[]): Promise<ReadonlyMap<string, string>>;
  readRetiredPlayers(matchId: string): Promise<ReadonlySet<string>>;
  readDeletedAccounts(accountIds: string[]): Promise<ReadonlySet<string>>;
}

export async function redactParticipants<
  T extends {
    id?: string;
    participants: { id?: string; kind: string; name: string; accountId?: string | null }[];
  },
>(store: ParticipantPrivacyReader, record: T): Promise<T> {
  const originalIds = record.participants.flatMap((p) => (p.accountId ? [p.accountId] : []));
  if (originalIds.length) {
    const canonical = await store.readCanonicalAccounts(originalIds);
    if (canonical.size)
      record = {
        ...record,
        participants: record.participants.map((p) =>
          p.accountId && canonical.has(p.accountId)
            ? { ...p, accountId: canonical.get(p.accountId)! }
            : p,
        ),
      };
  }
  const ids = record.participants.flatMap((p) =>
    p.kind === "human" && p.accountId ? [p.accountId] : [],
  );
  const retiredPlayers = record.id ? await store.readRetiredPlayers(record.id) : new Set<string>();
  const deleted = ids.length ? await store.readDeletedAccounts(ids) : new Set<string>();
  return redactRetiredParticipants(record, retiredPlayers, deleted);
}
