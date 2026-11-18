import type { FeedbackPatch, FeedbackRecord } from "@tetraboard/protocol";

type FeedbackEditor = { id: string; name: string };

export interface FeedbackEditStore<Row extends { id: string }> {
  read(id: string): Promise<Row | null>;
  topicExists(id: string): Promise<boolean>;
  update(row: Row, input: FeedbackPatch, editor: FeedbackEditor): Promise<boolean>;
  record(row: Row): FeedbackRecord;
}

export async function editFeedback<Row extends { id: string }>(
  store: FeedbackEditStore<Row>,
  id: string,
  input: FeedbackPatch,
  editor: FeedbackEditor,
) {
  const row = await store.read(id);
  if (!row) return { status: "not_found" } as const;
  if (input.topicId && !(await store.topicExists(input.topicId)))
    return { status: "topic_not_found" } as const;
  if (!(await store.update(row, input, editor))) return { status: "conflict" } as const;
  const updated = await store.read(row.id);
  if (!updated) return { status: "not_found" } as const;
  return { status: "updated", feedback: store.record(updated) } as const;
}
