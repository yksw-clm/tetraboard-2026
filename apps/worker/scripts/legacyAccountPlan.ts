import { profileInputSchema } from "@tetraboard/protocol";

type LegacyUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: number;
  image: string | null;
  createdAt: number;
  updatedAt: number;
  username: string | null;
  profileCompleted: number | null;
  avatarKey: string | null;
  isAnonymous?: number | null;
  isTestUser?: number | null;
};
type LegacyAccount = {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  createdAt: number;
  updatedAt: number;
};
export type AccountSnapshot = { users: LegacyUser[]; accounts: LegacyAccount[] };
const avatarPattern =
  /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
const literal = (value: string | number | null) => {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Invalid numeric field");
    return String(value);
  }
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid text field");
  return `'${value.replaceAll("'", "''")}'`;
};
const insert = (table: string, values: Record<string, string | number | null>) =>
  `INSERT INTO "${table}" (${Object.keys(values)
    .map((key) => `"${key}"`)
    .join(", ")}) VALUES (${Object.values(values).map(literal).join(", ")});`;
export function prepareLegacyAccounts(source: AccountSnapshot, target: AccountSnapshot) {
  const sql: string[] = [];
  const avatars = new Set<string>();
  const seenIds = new Set<string>(),
    seenEmails = new Set<string>(),
    seenNames = new Set<string>(),
    seenAccounts = new Set<string>();
  const users = source.users.filter((user) => !user.isAnonymous && !user.isTestUser);
  for (const user of users) {
    if (!user.id || !user.email || (!user.name && user.profileCompleted))
      throw new Error("Invalid account identity");
    const profile = user.profileCompleted
      ? profileInputSchema.safeParse({ name: user.name, username: user.username })
      : null;
    if (profile && !profile.success)
      throw new Error("Legacy profile needs review before migration");
    const username = profile?.success ? profile.data.username : null;
    if (
      seenIds.has(user.id) ||
      seenEmails.has(user.email.toLowerCase()) ||
      (username && seenNames.has(username))
    )
      throw new Error("Duplicate source identity");
    seenIds.add(user.id);
    seenEmails.add(user.email.toLowerCase());
    if (username) seenNames.add(username);
    const accounts = source.accounts.filter(
      (account) => account.userId === user.id && account.providerId === "google",
    );
    if (accounts.length !== 1) throw new Error("Each migrated user must have one Google identity");
    let image: string | null = null;
    if (user.avatarKey) {
      if (!avatarPattern.test(user.avatarKey)) throw new Error("Unsupported legacy avatar key");
      image = `/api/avatars/${user.avatarKey.slice(8, -5)}`;
      avatars.add(user.avatarKey);
    }
    const values = {
      id: user.id,
      name: profile?.success ? profile.data.name : "",
      email: user.email,
      emailVerified: user.emailVerified ? 1 : 0,
      image,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      username,
      profileCompleted: user.profileCompleted ? 1 : 0,
      avatarKey: user.avatarKey,
      isAnonymous: 0,
      isTestUser: 0,
      guestNameCustomized: 0,
    };
    const existing = target.users.find((candidate) => candidate.id === user.id);
    if (
      target.users.some(
        (candidate) =>
          candidate.id !== user.id &&
          (candidate.email.toLowerCase() === user.email.toLowerCase() ||
            (username && candidate.username?.toLowerCase() === username)),
      )
    )
      throw new Error("Target email or username conflict; no automatic merge is allowed");
    if (existing) {
      for (const key of [
        "name",
        "email",
        "username",
        "image",
        "profileCompleted",
        "avatarKey",
      ] as const)
        if ((existing[key] ?? null) !== values[key])
          throw new Error("Target profile differs; existing data will not be overwritten");
    } else sql.push(insert("user", values));
    for (const account of accounts) {
      if (!account.id || !account.accountId || seenAccounts.has(account.accountId))
        throw new Error("Invalid or duplicate Google identity");
      seenAccounts.add(account.accountId);
      const sameId = target.accounts.find((candidate) => candidate.id === account.id);
      const sameIdentity = target.accounts.find(
        (candidate) =>
          candidate.providerId === "google" && candidate.accountId === account.accountId,
      );
      if (
        (sameId &&
          (sameId.providerId !== "google" ||
            sameId.accountId !== account.accountId ||
            sameId.userId !== user.id)) ||
        (sameIdentity && sameIdentity.userId !== user.id)
      )
        throw new Error("Target Google identity conflict; no automatic merge is allowed");
      if (!sameIdentity)
        sql.push(
          insert("account", {
            id: account.id,
            accountId: account.accountId,
            providerId: "google",
            userId: user.id,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
          }),
        );
    }
  }
  return { sql: sql.join("\n") + "\n", avatars: [...avatars], users: users.length };
}
export function readSnapshot(value: unknown): AccountSnapshot {
  // Wrangler --jsonと、同じ形の合成スナップショットを受け付けます。
  const decoded = Array.isArray(value)
    ? JSON.parse(value[0]?.results?.[0]?.snapshot ?? "null")
    : value;
  if (!decoded || !Array.isArray(decoded.users) || !Array.isArray(decoded.accounts))
    throw new Error("Invalid account snapshot");
  return decoded as AccountSnapshot;
}
