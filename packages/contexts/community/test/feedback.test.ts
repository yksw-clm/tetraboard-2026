import { expect, test } from "bun:test";
import type { FeedbackInput } from "@tetraboard/protocol";
import {
  feedbackLimits,
  purgeExpiredFeedback,
  submitFeedback,
  validFeedbackImage,
  type FeedbackSubmission,
  type FeedbackSubmissionStore,
} from "@tetraboard/context-community";

const input: FeedbackInput = {
  submissionId: "bfbaffe3-b77a-44f4-bf98-b8f9c56040a4",
  accountRequired: false,
  kind: "request",
  game: "all",
  body: "要望",
  expectation: "",
  steps: "",
  technical: null,
};
const identity = {
  reporterHash: "author",
  browserHash: "browser",
  ipHash: "ip",
  author: "account",
  accountId: "author",
  internal: false,
} as const;
const image = Uint8Array.of(1, 2, 3);
const now = 86_400_000;
const row: FeedbackSubmission = {
  id: "feedback",
  deleted: false,
  expiresAtMs: now + 1,
  payloadHash: "same",
  ready: false,
  attachmentKey: "feedback/image.webp",
};
const submission = { input, identity, payloadHash: "same", image };

function submissionStore(existing: FeedbackSubmission | null) {
  const attachments = new Map<string, Uint8Array>();
  const ready = new Set<string>();
  const store: FeedbackSubmissionStore = {
    findSubmission: async () => existing,
    reserve: async () => null,
    async saveAttachment(key, bytes) {
      attachments.set(key, bytes);
    },
    authorWasDeleted: async () => false,
    async markReady(id) {
      if (!attachments.has(row.attachmentKey!)) throw new Error("missing image");
      ready.add(id);
    },
    isReady: async (id) => ready.has(id),
  };
  return { store, attachments, ready };
}

test("ゲストの報告者とブラウザの固定窓を重複させず、窓の境界で切り替える", () => {
  const limits = feedbackLimits({ ...identity, reporterHash: identity.browserHash }, now);
  expect(limits).toEqual([
    { key: "browser:600000", span: 600_000, max: 5, start: now },
    { key: "browser:86400000", span: 86_400_000, max: 20, start: now },
    { key: "ip:600000", span: 600_000, max: 30, start: now },
  ]);
});

test("登録者では本人とブラウザの短期・長期の上限を両方適用する", () => {
  const limits = feedbackLimits(identity, now - 1);
  expect(limits.map(({ key, start }) => [key, start])).toEqual([
    ["author:600000", now - 600_000],
    ["author:86400000", 0],
    ["browser:600000", now - 600_000],
    ["browser:86400000", 0],
    ["ip:600000", now - 600_000],
  ]);
});

test("予約後に中断した送信を再試行すると、添付を保存してから同じIDを受付済みにする", async () => {
  const { store, attachments, ready } = submissionStore(row);
  const result = await submitFeedback(store, submission, () => now);

  expect(result).toEqual({ status: "accepted", id: row.id });
  expect(attachments.get(row.attachmentKey!)).toEqual(image);
  expect([...ready]).toEqual([row.id]);
});

test.each([{ deleted: true }, { expiresAtMs: now }, { payloadHash: "old" }])(
  "削除、期限切れ、または内容が異なる再送を拒否する (%j)",
  async (change) => {
    const { store, attachments, ready } = submissionStore({ ...row, ...change });
    const result = await submitFeedback(store, submission, () => now);

    expect(result).toEqual({ status: "conflict" });
    expect(attachments.size).toBe(0);
    expect(ready.size).toBe(0);
  },
);

test("受付済みの同一送信は添付を再保存せず同じIDを返す", async () => {
  const { store, attachments } = submissionStore({ ...row, ready: true });
  const result = await submitFeedback(store, submission, () => now);

  expect(result).toEqual({ status: "accepted", id: row.id });
  expect(attachments.size).toBe(0);
});

test("予約できないときは受付せず送信上限を報告する", async () => {
  const { store } = submissionStore(null);
  expect(await submitFeedback(store, submission, () => now)).toEqual({ status: "rate_limited" });
});

test("画像保存後に退会が確認できた場合は受付を確定しない", async () => {
  const { store, attachments, ready } = submissionStore(row);
  store.authorWasDeleted = async (id, key) => {
    expect(id).toBe(identity.accountId);
    expect(attachments.get(key!)).toEqual(image);
    attachments.delete(key!);
    return true;
  };
  const result = await submitFeedback(store, submission, () => now);

  expect(result).toEqual({ status: "author_deleted" });
  expect(ready.size).toBe(0);
});

function webp(width: number, height: number) {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBPVP8 "), 8);
  bytes.set([0x9d, 0x01, 0x2a], 23);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 22, true);
  view.setUint32(16, 10, true);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}

test.each([
  [1600, 1600, true],
  [1601, 900, false],
  [900, 1601, false],
  [0, 900, false],
] as const)("WebPの寸法 %d×%d の判定は %s", (width, height, valid) => {
  expect(validFeedbackImage(webp(width, height))).toBe(valid);
});

test("メタデータのチャンクがあるWebPを拒否する", () => {
  const bytes = new Uint8Array(38);
  bytes.set(webp(1600, 900));
  bytes.set(new TextEncoder().encode("EXIF"), 30);
  new DataView(bytes.buffer).setUint32(4, 30, true);
  expect(validFeedbackImage(bytes)).toBe(false);
});

test("画像削除の失敗時は投稿を非表示で残し、他の期限処理を続ける", async () => {
  const hidden = new Set<string>();
  const deleted = new Set<string>();
  const rows = [
    { id: "with-image", attachmentKey: "picture" },
    { id: "text", attachmentKey: null },
  ];
  await purgeExpiredFeedback(
    {
      findExpired: async () => rows,
      async hide(id) {
        hidden.add(id);
      },
      async deleteAttachment() {
        throw new Error("unavailable");
      },
      async deleteFeedback(id) {
        deleted.add(id);
      },
      findOrphanAttachments: async () => [],
      async deleteUpload() {
        throw new Error("unexpected delete");
      },
      async deleteExpiredLimits() {
        deleted.add("limits");
      },
    },
    now,
  );

  expect([...hidden]).toEqual(["with-image", "text"]);
  expect([...deleted]).toEqual(["text", "limits"]);
});
