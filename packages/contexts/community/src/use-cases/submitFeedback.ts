import type { FeedbackInput } from "@tetraboard/protocol";
import type { FeedbackLimitIdentity } from "../domain/feedback";

export type FeedbackIdentity = FeedbackLimitIdentity & {
  author: "account" | "guest";
  accountId: string | null;
  internal: boolean;
};

export type FeedbackSubmission = {
  id: string;
  deleted: boolean;
  expiresAtMs: number;
  payloadHash: string;
  ready: boolean;
  attachmentKey: string | null;
};

export interface FeedbackSubmissionStore {
  findSubmission(id: string): Promise<FeedbackSubmission | null>;
  reserve(
    input: FeedbackInput,
    identity: FeedbackIdentity,
    payloadHash: string,
    attachment: boolean,
  ): Promise<FeedbackSubmission | null>;
  saveAttachment(key: string, image: Uint8Array): Promise<void>;
  authorWasDeleted(accountId: string, attachmentKey: string | null): Promise<boolean>;
  markReady(id: string, now: number): Promise<void>;
  isReady(id: string): Promise<boolean>;
}

export async function submitFeedback(
  store: FeedbackSubmissionStore,
  submission: {
    input: FeedbackInput;
    identity: FeedbackIdentity;
    payloadHash: string;
    image: Uint8Array | null;
  },
  now: () => number,
) {
  const { input, identity, payloadHash, image } = submission;
  const row =
    (await store.findSubmission(input.submissionId)) ??
    (await store.reserve(input, identity, payloadHash, image !== null));
  if (!row) return { status: "rate_limited" } as const;
  if (row.deleted || row.expiresAtMs <= now() || row.payloadHash !== payloadHash)
    return { status: "conflict" } as const;
  if (!row.ready) {
    if (row.attachmentKey && image) await store.saveAttachment(row.attachmentKey, image);
    if (
      identity.accountId !== null &&
      (await store.authorWasDeleted(identity.accountId, row.attachmentKey))
    )
      return { status: "author_deleted" } as const;
    await store.markReady(row.id, now());
    if (!(await store.isReady(row.id))) throw new Error("incomplete");
  }
  return { status: "accepted", id: row.id } as const;
}
