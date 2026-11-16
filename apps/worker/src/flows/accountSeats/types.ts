import type { AccountAdmission } from "../../accounts/roomAccounts";

export const accountCleanupKey = "account-cleanups";
export type StoredAccountSeat = AccountAdmission & { occupying: boolean };
export type AccountCleanup = {
  reservation: AccountAdmission;
  releaseAvatar: boolean;
  retryAtMs: number;
};
