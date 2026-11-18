export type AccountAdmission = {
  accountId: string;
  operationId: string;
  roomId: string;
  instanceId: string;
  playerId: string;
  name: string;
  avatarKey: string | null;
  avatarPresetId?: string | null;
  isGuest?: boolean;
};
export type AccountReservation = AccountAdmission & { createdAtMs: number };

export const accountCleanupKey = "account-cleanups";
export type StoredAccountSeat = AccountAdmission & { occupying: boolean };
export type AccountCleanup = {
  reservation: AccountAdmission;
  releaseAvatar: boolean;
  retryAtMs: number;
};
