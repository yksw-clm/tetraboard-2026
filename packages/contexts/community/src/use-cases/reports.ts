import type { ChatMessage, ModerationReport } from "@tetraboard/protocol";
import {
  parseReportCursor,
  reportPage,
  reportPageSize,
  reportSubmissionWindow,
  type ReportCursor,
} from "../domain/reports";

export interface ReportListStore<Row> {
  readPage(after: ReportCursor | null, take: number): Promise<Row[]>;
  toReport(row: Row): ModerationReport;
  position(row: Row): ReportCursor;
}

export async function listReports<Row>(store: ReportListStore<Row>, cursor: string | undefined) {
  const after = parseReportCursor(cursor);
  const rows = await store.readPage(after, reportPageSize + 1);
  return reportPage(rows, store.toReport, store.position);
}

export type ReportSubmission = {
  roomId: string;
  instanceId: string;
  message: ChatMessage;
  reporterHash: string;
};

export interface ReportSubmissionStore {
  insert(
    input: ReportSubmission,
    id: string,
    now: number,
    window: ReturnType<typeof reportSubmissionWindow>,
  ): Promise<boolean>;
  hasDuplicate(input: ReportSubmission, now: number): Promise<boolean>;
}

export async function submitRoomReport(
  store: ReportSubmissionStore,
  input: ReportSubmission,
  now: number,
  id: string,
): Promise<{ status: "created"; id: string } | { status: "duplicate" | "rate_limited" }> {
  if (await store.insert(input, id, now, reportSubmissionWindow(now)))
    return { status: "created", id };
  return { status: (await store.hasDuplicate(input, now)) ? "duplicate" : "rate_limited" };
}

type ModerationAction = NonNullable<ModerationReport["action"]>;

export interface ReportModerationStore {
  read(id: string): Promise<ModerationReport | null>;
  apply(
    report: ModerationReport,
    remove: boolean,
    mute: boolean,
  ): Promise<"applied" | "room_changed">;
  resolve(id: string, action: ModerationAction): Promise<ModerationReport | null>;
}

export async function moderateRoomReport(
  store: ReportModerationStore,
  id: string,
  action: ModerationAction,
) {
  const report = await store.read(id);
  if (!report) return { status: "not_found" } as const;
  if (report.status === "resolved") {
    return report.action === action
      ? ({ status: "already_resolved", report } as const)
      : ({ status: "conflict" } as const);
  }
  if (action !== "dismiss") {
    const status = await store.apply(
      report,
      action === "delete" || action === "delete_and_mute",
      action === "mute" || action === "delete_and_mute",
    );
    if (status === "room_changed") return { status: "conflict" } as const;
  }
  const resolved = await store.resolve(id, action);
  if (!resolved) return { status: "not_found" } as const;
  if (resolved.action !== action) return { status: "conflict" } as const;
  return { status: "resolved", report: resolved } as const;
}
