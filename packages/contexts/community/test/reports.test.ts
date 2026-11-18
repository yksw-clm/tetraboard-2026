import { expect, test } from "bun:test";
import type { ModerationReport } from "@tetraboard/protocol";
import {
  listReports,
  moderateRoomReport,
  parseReportCursor,
  reportPage,
  submitRoomReport,
  type ReportSubmission,
} from "@tetraboard/context-community";

const id = "bfbaffe3-b77a-44f4-bf98-b8f9c56040a4";
const input: ReportSubmission = {
  roomId: "12345",
  instanceId: id,
  message: {
    id,
    senderId: "sender",
    senderName: "名前",
    text: "本文",
    sentAtMs: 100,
    kind: "player",
  },
  reporterHash: "reporter",
};
const now = 100_000;

test.each([
  { preceding: now - 2_999, status: "rate_limited" },
  { preceding: now - 3_000, status: "created" },
])("直前の通報時刻が $preceding のときは $status", async ({ preceding, status }) => {
  const result = await submitRoomReport(
    {
      async insert(_input, _id, _now, { precedingReportAfter, expiresAtMs }) {
        expect(expiresAtMs).toBe(now + 7 * 86_400_000);
        return preceding <= precedingReportAfter;
      },
      hasDuplicate: async () => false,
    },
    input,
    now,
    id,
  );

  expect(result.status).toBe(status);
});

test("登録できなかった通報は、同じ発言の有効な通報があれば重複を返す", async () => {
  const result = await submitRoomReport(
    {
      insert: async () => false,
      hasDuplicate: async (target, asOf) => target.message.id === id && asOf === now,
    },
    input,
    now,
    id,
  );

  expect(result).toEqual({ status: "duplicate" });
});

test("通報一覧の次のカーソルは余分に取得した行ではなく20件目を指す", () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({ time: now - index, id }));
  const result = reportPage(
    rows,
    (row) => row,
    (row) => row,
  );

  expect(result.reports).toHaveLength(20);
  expect(parseReportCursor(result.nextCursor ?? undefined)).toEqual(rows[19]);
});

const pendingReport: ModerationReport = {
  id,
  roomId: input.roomId,
  instanceId: input.instanceId,
  message: input.message,
  action: null,
  status: "open",
  reportedAtMs: now,
};
const reportPosition = (report: ModerationReport) => ({ time: report.reportedAtMs, id: report.id });

test("一覧は解読したカーソルを渡し、21件目を返さず20件目を次のカーソルにする", async () => {
  const reports = Array.from({ length: 20 }, (_, index) => ({
    ...pendingReport,
    reportedAtMs: now - index - 1,
  }));
  const rows = [...reports, { ...pendingReport, reportedAtMs: now - 21 }];
  const cursor = `${now}:${id}`;
  const result = await listReports(
    {
      async readPage(after, take) {
        expect(after).toEqual({ time: now, id });
        expect(take).toBe(21);
        return rows.slice(0, take);
      },
      toReport(row) {
        if (row.reportedAtMs === now - 21) throw new Error("Unexpected lookahead conversion");
        return row;
      },
      position: reportPosition,
    },
    cursor,
  );

  expect(result).toEqual({ reports, nextCursor: `${now - 20}:${id}` });
});

test("初回の一覧が20件ちょうどなら次のカーソルはない", async () => {
  const reports = Array.from({ length: 20 }, (_, index) => ({
    ...pendingReport,
    reportedAtMs: now - index,
  }));
  const result = await listReports(
    {
      async readPage(after) {
        expect(after).toBeNull();
        return reports;
      },
      toReport: (report) => report,
      position: reportPosition,
    },
    undefined,
  );

  expect(result).toEqual({ reports, nextCursor: null });
});

test("カーソルの時刻が安全な整数でなければ保存先を呼ばない", async () => {
  const result = listReports(
    {
      async readPage(): Promise<ModerationReport[]> {
        throw new Error("Unexpected query");
      },
      toReport: (report) => report,
      position: reportPosition,
    },
    `9007199254740992:${id}`,
  );

  await expect(result).rejects.toThrow("Invalid cursor");
});

test("部屋の世代が変わった場合は通報を解決済みにしない", async () => {
  const result = await moderateRoomReport(
    {
      read: async () => pendingReport,
      apply: async (_report, remove, mute) => {
        expect({ remove, mute }).toEqual({ remove: true, mute: true });
        return "room_changed";
      },
      resolve: async () => {
        throw new Error("unexpected resolve");
      },
    },
    id,
    "delete_and_mute",
  );

  expect(result).toEqual({ status: "conflict" });
});
