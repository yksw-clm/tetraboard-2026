CREATE TABLE "gameMatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "roomId" TEXT NOT NULL,
  "game" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "startedAt" INTEGER NOT NULL,
  "finishedAt" INTEGER NOT NULL,
  "recordKey" TEXT NOT NULL UNIQUE,
  "createdAt" INTEGER NOT NULL
);

CREATE TABLE "gameMatchPlayer" (
  "matchId" TEXT NOT NULL REFERENCES "gameMatch" ("id") ON DELETE CASCADE,
  "participantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "avatarUrl" TEXT,
  "isGuest" INTEGER NOT NULL DEFAULT 0,
  "seat" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "placement" INTEGER,
  "discCount" INTEGER,
  "color" TEXT,
  "eliminations" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("matchId", "participantId")
);

CREATE TABLE "gameMatchOwner" (
  "matchId" TEXT NOT NULL REFERENCES "gameMatch" ("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "participantId" TEXT NOT NULL,
  "expiresAt" INTEGER,
  PRIMARY KEY ("matchId", "userId")
);

CREATE INDEX "gameMatch_finishedAt_idx" ON "gameMatch" ("finishedAt" DESC, "id" DESC);
CREATE INDEX "gameMatch_game_finishedAt_idx" ON "gameMatch" ("game", "finishedAt" DESC, "id" DESC);
CREATE INDEX "gameMatchOwner_userId_idx" ON "gameMatchOwner" ("userId", "expiresAt");
CREATE INDEX "gameMatchOwner_matchId_idx" ON "gameMatchOwner" ("matchId");

ALTER TABLE gameMatch ADD COLUMN finalState TEXT;
ALTER TABLE gameMatch ADD COLUMN formatVersion INTEGER NOT NULL DEFAULT 1;
ALTER TABLE gameMatchPlayer ADD COLUMN username TEXT;
ALTER TABLE gameMatchPlayer ADD COLUMN kind TEXT NOT NULL DEFAULT 'human';
ALTER TABLE gameMatchPlayer ADD COLUMN level INTEGER;
ALTER TABLE room_index ADD COLUMN host_avatar_url TEXT;
CREATE UNIQUE INDEX account_provider_identity_idx ON account(providerId, accountId);
