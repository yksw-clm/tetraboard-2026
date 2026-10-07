import { feedbackRecordSchema } from "@tetraboard/protocol";
export const id = "00000000-0000-4000-8000-000000000091";
export const topicId = "00000000-0000-4000-8000-000000000092";
const now = 1791039600000;
export const record = feedbackRecordSchema.parse({
  id,
  kind: "bug",
  game: "four-shogi",
  body: "スマホで持ち駒が操作しづらいです。".repeat(5),
  expectation: "片手で駒を選びたい",
  steps: "画面を横にした後、持ち駒を押す",
  technical: {
    page: "room",
    game: "four-shogi",
    browser: "test browser",
    width: 390,
    height: 900,
    build: "test",
    room: { id: "12345", instanceId: topicId, roundId: topicId },
  },
  author: "guest",
  internal: false,
  receivedAtMs: now,
  expiresAtMs: now + 180 * 86400000,
  firstReviewedAtMs: null,
  status: "new",
  priority: "normal",
  topicId: null,
  note: "",
  issueUrl: "",
  hasAttachment: true,
  version: 1,
});
