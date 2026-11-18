import { expect, mock, test } from "bun:test";
import { redactParticipants, retiredName } from "@tetraboard/context-privacy";

test("統合先が退会済みの参加者と退会済みの棋譜参照から名前とレートを除く", async () => {
  const store = {
    readCanonicalAccounts: mock(async () => new Map([["guest", "retired-account"]])),
    readRetiredPlayers: mock(async () => new Set(["retired-without-account"])),
    readDeletedAccounts: mock(async () => new Set(["retired-account"])),
  };
  const record: {
    id: string;
    participants: {
      id: string;
      kind: string;
      name: string;
      accountId: string | null;
      retired?: true;
    }[];
    profileRatings: Record<string, number>;
  } = {
    id: "match",
    participants: [
      { id: "merged", kind: "human", name: "Guest name", accountId: "guest" },
      { id: "retired-without-account", kind: "human", name: "Old name", accountId: null },
      { id: "other", kind: "human", name: "Other name", accountId: "other-account" },
    ],
    profileRatings: { merged: 1200, "retired-without-account": 1400, other: 1600 },
  };
  const redacted = await redactParticipants(store, record);
  expect(store.readDeletedAccounts).toHaveBeenCalledWith(["retired-account", "other-account"]);
  expect(store.readRetiredPlayers).toHaveBeenCalledWith("match");
  expect(redacted).toEqual({
    ...record,
    participants: [
      { ...record.participants[0], name: retiredName, accountId: null, retired: true },
      { ...record.participants[1], name: retiredName, retired: true },
      record.participants[2],
    ],
    profileRatings: { other: 1600 },
  });
  expect(record.participants[0].accountId).toBe("guest");
});
