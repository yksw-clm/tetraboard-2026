import { expect, test } from "bun:test";
import type { FeedbackPatch, FeedbackRecord } from "@tetraboard/protocol";
import { editFeedback, type FeedbackEditStore } from "@tetraboard/context-community";

const feedback: FeedbackRecord = {
  id: "f9b9dfa9-fd79-4f30-9050-0e3e97b22496",
  kind: "request",
  game: "all",
  body: "要望",
  rating: null,
  opponent: null,
  expectation: "",
  steps: "",
  technical: null,
  author: "account",
  internal: false,
  receivedAtMs: 100,
  expiresAtMs: 200,
  firstReviewedAtMs: null,
  status: "new",
  priority: "normal",
  topicId: null,
  note: "",
  issueUrl: "",
  hasAttachment: false,
  version: 1,
};
const input: FeedbackPatch = {
  version: feedback.version,
  status: "reviewing",
  priority: "high",
  topicId: "33711166-7ddc-46cc-8711-c6d9bdaa245e",
  note: "確認中",
  issueUrl: "",
  published: false,
};
const editor = { id: "admin", name: "運営者" };

function editStore(overrides: Partial<FeedbackEditStore<FeedbackRecord>>) {
  return {
    read: async () => feedback,
    topicExists: async () => {
      throw new Error("Unexpected topic lookup");
    },
    update: async () => {
      throw new Error("Unexpected update");
    },
    record: (row) => row,
    ...overrides,
  } satisfies FeedbackEditStore<FeedbackRecord>;
}

test("テーマを照合し、編集者と版を渡して保存し、読み直した投稿を返す", async () => {
  const updated: FeedbackRecord = {
    ...feedback,
    status: input.status,
    priority: input.priority,
    topicId: input.topicId,
    note: input.note,
    firstReviewedAtMs: 150,
    version: 2,
  };
  let saved = feedback;
  const store = editStore({
    read: async (id) => (id === saved.id ? saved : null),
    topicExists: async (id) => id === input.topicId,
    async update(row, patch, actor) {
      expect(row).toEqual(feedback);
      expect(patch).toEqual(input);
      expect(actor).toEqual(editor);
      saved = updated;
      return true;
    },
  });

  const result = await editFeedback(store, feedback.id, input, editor);

  expect(result).toEqual({ status: "updated", feedback: updated });
});

test("投稿を読めなければテーマの照合や更新を行わない", async () => {
  const store = editStore({ read: async () => null });

  expect(await editFeedback(store, feedback.id, input, editor)).toEqual({ status: "not_found" });
});

test("指定したテーマが見つからなければ更新を行わない", async () => {
  const store = editStore({ topicExists: async () => false });

  expect(await editFeedback(store, feedback.id, input, editor)).toEqual({
    status: "topic_not_found",
  });
});

test("テーマなしの編集で指定版が古ければ競合を返す", async () => {
  const current = { ...feedback, version: 2 };
  const store = editStore({
    read: async () => current,
    update: async (row, patch) => row.version === patch.version,
  });

  const result = await editFeedback(store, feedback.id, { ...input, topicId: null }, editor);

  expect(result).toEqual({ status: "conflict" });
});

test("更新後の読み直しで投稿が見つからなければ not_found を返す", async () => {
  let hidden = false;
  const store = editStore({
    read: async () => (hidden ? null : feedback),
    async update() {
      hidden = true;
      return true;
    },
  });

  const result = await editFeedback(store, feedback.id, { ...input, topicId: null }, editor);

  expect(result).toEqual({ status: "not_found" });
});
