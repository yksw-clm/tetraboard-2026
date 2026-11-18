import { prepareFenceAbort } from "../../db/fenceAbort";

export function registrationAccountAllowed(account: "?" | "candidate.account_id") {
  return `NOT EXISTS (SELECT 1 FROM deleted_accounts WHERE id=${account})`;
}

export function prepareRegistrationUpdateAbort(
  db: D1Database,
  accountId: string,
  candidate: string,
  values: string[],
) {
  return prepareFenceAbort(db, {
    when: `changes()=0 AND NOT ${registrationAccountAllowed("?")}
      AND EXISTS(SELECT 1 FROM registration_flows WHERE ${candidate})`,
    values: [accountId, ...values],
    code: "registration account deleted",
  });
}
