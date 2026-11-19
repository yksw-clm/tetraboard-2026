import { retiredName } from "@tetraboard/context-privacy";
import type { AuthEnv } from "../../accounts/auth";
import { deactivateDeletedAccountStatements } from "../../adapters/account/deletionWrites";
import { avatarKeyPattern } from "../../adapters/account/profilePolicy";
import { hideDeletedFeedbackStatement } from "../../adapters/community/feedbackDeletion";
import {
  queueDeletionImagesStatements,
  queueRestoredAvatarStatement,
} from "../../adapters/privacy/deletionRequest";
import { retireDeletedAccountClaimStatements } from "../../adapters/record/matchClaimStore";
import { scrubDeletedAccountRecordsStatements } from "../../adapters/record/privacyScrub";
import { hideDeletedRoomPlayersStatements } from "../../adapters/room/indexDeletion";
import type { DeletionScope } from "../../db/deletionGuard";
import { feedbackAccountHash } from "./feedbackAccountHash";

export function deletionCascadeStatements(
  db: D1Database,
  deletion: DeletionScope,
  reporterHash: string,
) {
  return [
    hideDeletedFeedbackStatement(db, deletion, reporterHash),
    ...hideDeletedRoomPlayersStatements(db, deletion, retiredName),
    ...queueDeletionImagesStatements(db, deletion),
    ...retireDeletedAccountClaimStatements(db, deletion),
    ...scrubDeletedAccountRecordsStatements(db, deletion),
    ...deactivateDeletedAccountStatements(db, deletion, retiredName),
  ];
}

export async function reapplyDeletionCascade(env: AuthEnv, accountId: string) {
  const db = env.APP_DB;
  const reporterHash = await feedbackAccountHash(env, accountId);
  const avatarKey = await db
    .prepare("SELECT avatarKey FROM user WHERE id=?")
    .bind(accountId)
    .first<string>("avatarKey");
  const statements = deletionCascadeStatements(db, { accountId }, reporterHash);
  // 完了済みの台帳からは画像キーが消えているため、復元したキーを匿名化前に予約します。
  if (avatarKey && avatarKeyPattern.test(avatarKey))
    statements.unshift(queueRestoredAvatarStatement(db, accountId, avatarKey));
  await db.batch(statements);
}
