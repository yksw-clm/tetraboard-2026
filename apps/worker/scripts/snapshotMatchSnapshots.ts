import { z } from "zod";
import type { ConversionReport } from "./snapshotMatchPlan";

export const apiSnapshotSchema = z.object({
  version: z.literal(1),
  expectedIds: z.array(z.string()),
  matches: z.array(
    z.object({ id: z.string(), status: z.int().min(100).max(599), body: z.string() }),
  ),
});
export type ApiSnapshot = z.infer<typeof apiSnapshotSchema>;
type ResponseIssue = { path: string; reason: string };
type ComparisonIssue = ResponseIssue & { side: "before" | "after" };

function responseIssues(
  response: ApiSnapshot["matches"][number] | undefined,
  id: string,
): ResponseIssue[] {
  if (!response) return [{ path: "$snapshot.missing", reason: "Response is missing" }];
  const issues: ResponseIssue[] = [];
  if (response.status !== 200)
    issues.push({ path: "$status", reason: `Expected HTTP 200, received ${response.status}` });
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    issues.push({ path: "$body.invalid-json", reason: "Response body is not valid JSON" });
    return issues;
  }
  const parsed = z
    .object({
      match: z.object({ id: z.literal(id), replay: z.object({ steps: z.array(z.unknown()) }) }),
    })
    .safeParse(body);
  if (!parsed.success)
    issues.push(
      ...parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path.map(String)),
        reason: issue.message,
      })),
    );
  return issues;
}

export function invalidSnapshotResponses(snapshot: ApiSnapshot) {
  return snapshot.matches.flatMap((response) => {
    const issues = responseIssues(response, response.id);
    return issues.length ? [{ id: response.id, issues }] : [];
  });
}

export async function snapshotMatches(
  report: ConversionReport,
  base: string,
  options: {
    intervalMs?: number;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    save?: (snapshot: ApiSnapshot) => Promise<void>;
  } = {},
): Promise<ApiSnapshot> {
  const {
    intervalMs = 250,
    fetch: request = fetch,
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    save,
  } = options;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) throw new Error("Invalid interval");
  const url = new URL(base);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Expected HTTP base URL without credentials, query or fragment");
  const snapshot: ApiSnapshot = {
    version: 1,
    expectedIds: report.converted.map(({ id }) => id),
    matches: [],
  };
  for (const [index, match] of report.converted.entries()) {
    if (index > 0) await sleep(intervalMs);
    const response = await request(
      `${base.replace(/\/+$/u, "")}/api/matches/${encodeURIComponent(match.id)}`,
      {
        method: "GET",
        headers: { "User-Agent": "MatchReplayVerifier/1.0", Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    snapshot.matches.push({ id: match.id, status: response.status, body: await response.text() });
    await save?.(snapshot);
  }
  return snapshot;
}

function jsonPaths(before: unknown, after: unknown, path: string[] = []): string[][] {
  if (Object.is(before, after)) return [];
  if (
    typeof before !== "object" ||
    before === null ||
    typeof after !== "object" ||
    after === null ||
    Array.isArray(before) !== Array.isArray(after)
  )
    return [path];
  const left = before as Record<string, unknown>,
    right = after as Record<string, unknown>;
  const paths: string[][] = [];
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!(key in left) || !(key in right)) paths.push([...path, key]);
    else paths.push(...jsonPaths(left[key], right[key], [...path, key]));
  }
  return paths;
}
function formatPath(path: string[]): string {
  return "$" + path.map((key) => `[${JSON.stringify(key)}]`).join("");
}
function indexSnapshot(snapshot: ApiSnapshot) {
  const index = new Map<string, ApiSnapshot["matches"][number]>();
  for (const match of snapshot.matches) {
    if (index.has(match.id)) throw new Error(`Duplicate snapshot ID: ${match.id}`);
    index.set(match.id, match);
  }
  return index;
}
export function compareSnapshots(before: ApiSnapshot, after: ApiSnapshot) {
  const left = indexSnapshot(before),
    right = indexSnapshot(after);
  const failed: { id: string; paths: string[]; issues?: ComparisonIssue[] }[] = [];
  const outsideReplay: { id: string; paths: string[] }[] = [];
  const equal: string[] = [];
  for (const id of new Set([
    ...before.expectedIds,
    ...after.expectedIds,
    ...left.keys(),
    ...right.keys(),
  ])) {
    const a = left.get(id),
      b = right.get(id);
    const issues: ComparisonIssue[] = [
      ...responseIssues(a, id).map((issue) => ({ ...issue, side: "before" as const })),
      ...responseIssues(b, id).map((issue) => ({ ...issue, side: "after" as const })),
    ];
    if (issues.length) {
      failed.push({ id, paths: [...new Set(issues.map((issue) => issue.path))], issues });
      continue;
    }
    const fatal: string[] = [],
      outside: string[] = [];
    compareBodies(a!.body, b!.body, fatal, outside);
    if (fatal.length) failed.push({ id, paths: fatal });
    if (outside.length) outsideReplay.push({ id, paths: outside });
    if (!fatal.length && !outside.length) equal.push(id);
  }
  if (!left.size && !right.size) failed.push({ id: "", paths: ["$snapshot.empty"] });
  return { equal, failed, outsideReplay };
}

function compareBodies(before: string, after: string, fatal: string[], outside: string[]) {
  if (before === after) return;
  try {
    const a: unknown = JSON.parse(before),
      b: unknown = JSON.parse(after);
    const paths = jsonPaths(a, b);
    for (const path of paths) {
      // APIの応答がラップされていてもreplayの差異を取りこぼさないようにします。
      const affectsReplay =
        path.includes("replay") || path.length === 0 || changedAncestorReplay(a, b, path);
      (affectsReplay ? fatal : outside).push(formatPath(path));
    }
    if (!paths.length) outside.push("$body.encoding");
  } catch {
    fatal.push("$body.invalid-json");
  }
}
function changedAncestorReplay(a: unknown, b: unknown, path: string[]): boolean {
  for (const key of path) {
    a = a && typeof a === "object" ? (a as Record<string, unknown>)[key] : undefined;
    b = b && typeof b === "object" ? (b as Record<string, unknown>)[key] : undefined;
  }
  return containsReplay(a) || containsReplay(b);
}
function containsReplay(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    ("replay" in value || Object.values(value).some(containsReplay))
  );
}
