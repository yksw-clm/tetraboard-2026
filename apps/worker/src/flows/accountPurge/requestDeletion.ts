import { retiredName } from "@tetraboard/context-privacy";
import type { AuthEnv } from "../../accounts/auth";
import { deactivateDeletedAccountStatements } from "../../adapters/account/deletionWrites";
import { hideDeletedFeedbackStatement } from "../../adapters/community/feedbackDeletion";
import {
  insertDeletionStatement,
  queueDeletionStatements,
  saveDeletionReceiptStatement,
} from "../../adapters/privacy/deletionRequest";
import { retireDeletedAccountClaimStatements } from "../../adapters/record/matchClaimStore";
import { scrubDeletedAccountRecordsStatements } from "../../adapters/record/privacyScrub";
import { hideDeletedRoomPlayersStatements } from "../../adapters/room/indexDeletion";
import { digest } from "../../crypto";
import { feedbackAccountHash } from "./feedbackAccountHash";

export async function requestDeletion(env: AuthEnv, id: string, receipt: string) {
  const db = env.APP_DB;
  const tokenHash = await digest(receipt);
  const reporterHash = await feedbackAccountHash(env, id);
  // 同じ受付票の再送でも、新しく INSERT できた batch だけが連鎖を実行します。
  const deletion = { accountId: id, batchReceipt: `batch:${crypto.randomUUID()}` };
  const results = await db.batch([
    insertDeletionStatement(db, deletion, Date.now()),
    hideDeletedFeedbackStatement(db, deletion, reporterHash),
    ...hideDeletedRoomPlayersStatements(db, deletion, retiredName),
    ...queueDeletionStatements(db, deletion),
    ...retireDeletedAccountClaimStatements(db, deletion),
    ...scrubDeletedAccountRecordsStatements(db, deletion),
    ...deactivateDeletedAccountStatements(db, deletion, retiredName),
    ...[
      "tournament_wait_reservations",
      "matchmaking_wait_reservations",
      "elo_rating_changes",
      "skill_rating_changes",
      "elo_rating_pending",
      "skill_rating_pending",
    ].map((table) =>
      db
        .prepare(
          `DELETE FROM ${table} WHERE account_id=? AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=? AND receipt_hash=?)`,
        )
        .bind(id, id, deletion.batchReceipt),
    ),
    db
      .prepare(
        "UPDATE tournament_entries SET deleted=1 WHERE account_id=? AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=? AND receipt_hash=?)",
      )
      .bind(id, id, deletion.batchReceipt),
    saveDeletionReceiptStatement(db, deletion, tokenHash),
  ]);
  return results[0].results.length === 1;
}
