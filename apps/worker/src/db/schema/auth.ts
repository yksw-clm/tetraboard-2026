import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const user = sqliteTable(
  "user",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("emailVerified").notNull(),
    image: text("image"),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
    isAnonymous: integer("isAnonymous"),
    username: text("username"),
    profileCompleted: integer("profileCompleted"),
    avatarKey: text("avatarKey"),
    isTestUser: integer("isTestUser"),
    guestNameCustomized: integer("guestNameCustomized"),
    publicProfileId: text("publicProfileId"),
    guestRegisteredAt: integer("guestRegisteredAt"),
    avatarPresetId: text("avatarPresetId"),
    profileMessage: text("profileMessage")
      .notNull()
      .default(sql`''`),
    favoriteGames: text("favoriteGames")
      .notNull()
      .default(sql`'[]'`),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    unique("user_email_unique").on(t.email),
    unique("user_username_unique").on(t.username),
    uniqueIndex("user_username_normalized_idx").on(sql`LOWER("username")`),
    uniqueIndex("user_public_profile_id_idx").on(t.publicProfileId),
  ],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").notNull(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: integer("accessTokenExpiresAt"),
    refreshTokenExpiresAt: integer("refreshTokenExpiresAt"),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("account_userId_idx").on(t.userId),
    uniqueIndex("account_provider_identity_idx").on(t.providerId, t.accountId),
  ],
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").notNull(),
    expiresAt: integer("expiresAt").notNull(),
    token: text("token").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    unique("session_token_unique").on(t.token),
    index("session_userId_idx").on(t.userId),
  ],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").notNull(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expiresAt").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] }), index("verification_identifier_idx").on(t.identifier)],
);

export const rateLimit = sqliteTable(
  "rateLimit",
  {
    id: text("id").notNull(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: integer("lastRequest").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] }), unique("rateLimit_key_unique").on(t.key)],
);

export const avatarDeletions = sqliteTable(
  "avatar_deletions",
  {
    key: text("key").notNull(),
  },
  (t) => [primaryKey({ columns: [t.key] })],
);
