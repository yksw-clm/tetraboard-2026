import { expect, test, vi } from "vitest";
import { planSnapshotMatches } from "../scripts/snapshotMatchPlan";
import {
  apiSnapshotSchema,
  compareSnapshots,
  invalidSnapshotResponses,
  snapshotMatches,
  type ApiSnapshot,
} from "../scripts/snapshotMatchSnapshots";
import { snapshotConversionFixtures, exportRow } from "./snapshotConversionFixtures";

function snapshot(body: unknown, status = 200): ApiSnapshot {
  return {
    version: 1,
    expectedIds: ["match-id"],
    matches: [{ id: "match-id", status, body: JSON.stringify(body) }],
  };
}
test("replay差異とプロフィール差異を別のJSON経路で報告する", () => {
  const before = snapshot({
    match: {
      id: "match-id",
      replay: { steps: [{ game: { moveNumber: 1 } }] },
      participants: [{ name: "前" }],
    },
  });
  const after = snapshot({
    match: {
      id: "match-id",
      replay: { steps: [{ game: { moveNumber: 2 } }] },
      participants: [{ name: "後" }],
    },
  });
  expect(compareSnapshots(before, after)).toEqual({
    equal: [],
    failed: [
      { id: "match-id", paths: ['$["match"]["replay"]["steps"]["0"]["game"]["moveNumber"]'] },
    ],
    outsideReplay: [{ id: "match-id", paths: ['$["match"]["participants"]["0"]["name"]'] }],
  });
  const profileOnly = snapshot({
    match: {
      id: "match-id",
      replay: { steps: [{ game: { moveNumber: 1 } }] },
      participants: [{ name: "後" }],
    },
  });
  expect(compareSnapshots(before, profileOnly).failed).toEqual([]);
  expect(compareSnapshots(before, before).equal).toEqual(["match-id"]);
});

test("HTTP状態・欠落・replayの親の削除・非JSONの差異も検出する", () => {
  const before = snapshot({ match: { id: "match-id", replay: { steps: [] } } });
  expect(compareSnapshots(before, snapshot({})).failed[0].paths).toEqual(['$["match"]']);
  expect(compareSnapshots(before, snapshot({}, 503)).failed[0].paths).toContain("$status");
  expect(
    compareSnapshots(before, { version: 1, expectedIds: ["match-id"], matches: [] }).failed[0]
      .paths,
  ).toEqual(["$snapshot.missing"]);
  const invalid = {
    version: 1 as const,
    expectedIds: ["match-id"],
    matches: [{ id: "match-id", status: 200, body: "unavailable" }],
  };
  expect(compareSnapshots(before, invalid).failed[0].paths).toEqual(["$body.invalid-json"]);
  expect(() =>
    compareSnapshots(
      { version: 1, expectedIds: ["match-id"], matches: [...before.matches, ...before.matches] },
      before,
    ),
  ).toThrow("Duplicate");
  const partial: ApiSnapshot = { version: 1, expectedIds: ["not-fetched"], matches: [] };
  expect(compareSnapshots(partial, partial).failed[0]).toMatchObject({
    id: "not-fetched",
    paths: ["$snapshot.missing"],
  });
});

test("snapshotは順番にGETし、応答の間に指定間隔を空けて状態と本文を保存する", async () => {
  const { report } = planSnapshotMatches(
    snapshotConversionFixtures.slice(0, 3).map(({ json }) => exportRow(json)),
  );
  const calls: string[] = [];
  const save = vi.fn(async (_value: ApiSnapshot) => {});
  const request = vi.fn<typeof fetch>(async (url, init) => {
    calls.push(`fetch:${url}`);
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("User-Agent")).toBe("MatchReplayVerifier/1.0");
    const id = String(url).split("/").at(-1)!;
    return new Response(` ${JSON.stringify({ match: { id, replay: { steps: [] } } })}\n`, {
      status: 200,
    });
  });
  const sleep = vi.fn(async (ms: number) => {
    calls.push(`sleep:${ms}`);
  });
  const result = await snapshotMatches(report, "https://example.invalid/", {
    fetch: request,
    sleep,
    intervalMs: 17,
    save,
  });
  expect(calls).toEqual(
    report.converted.flatMap(({ id }, index) => [
      ...(index ? ["sleep:17"] : []),
      `fetch:https://example.invalid/api/matches/${id}`,
    ]),
  );
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenCalledTimes(3);
  expect(apiSnapshotSchema.parse(result).matches).toEqual(
    report.converted.map(({ id }) => ({
      id,
      status: 200,
      body: ` ${JSON.stringify({ match: { id, replay: { steps: [] } } })}\n`,
    })),
  );
  expect(invalidSnapshotResponses(result)).toEqual([]);
  await expect(
    snapshotMatches(report, "https://example.invalid", { intervalMs: -1, fetch: request }),
  ).rejects.toThrow("interval");
  await expect(
    snapshotMatches(report, "https://user:secret@example.invalid", { fetch: request }),
  ).rejects.toThrow("credentials");
});

const invalidResponses = [
  {
    name: "同じ503",
    status: 503,
    body: JSON.stringify({ match: { id: "match-id", replay: { steps: [] } } }),
    path: "$status",
    reason: "Expected HTTP 200, received 503",
  },
  {
    name: "同じ200のHTML",
    status: 200,
    body: "<html>unavailable</html>",
    path: "$body.invalid-json",
    reason: "Response body is not valid JSON",
  },
  {
    name: "idの違う棋譜",
    status: 200,
    body: JSON.stringify({ match: { id: "other-id", replay: { steps: [] } } }),
    path: '$["match"]["id"]',
    reason: expect.stringContaining("match-id"),
  },
  {
    name: "stepsのない棋譜",
    status: 200,
    body: JSON.stringify({ match: { id: "match-id", replay: {} } }),
    path: '$["match"]["replay"]["steps"]',
    reason: expect.stringContaining("array"),
  },
  {
    name: "stepsが配列でない棋譜",
    status: 200,
    body: JSON.stringify({ match: { id: "match-id", replay: { steps: {} } } }),
    path: '$["match"]["replay"]["steps"]',
    reason: expect.stringContaining("array"),
  },
];
test.each(invalidResponses)(
  "$nameは同じ応答でも一致にせず、前後それぞれの理由を示す",
  ({ status, body, path, reason }) => {
    const invalid = snapshot(null);
    invalid.matches[0] = { id: "match-id", status, body };
    expect(compareSnapshots(invalid, invalid)).toEqual({
      equal: [],
      outsideReplay: [],
      failed: [
        {
          id: "match-id",
          paths: [path],
          issues: [
            { side: "before", path, reason },
            { side: "after", path, reason },
          ],
        },
      ],
    });
    const valid = snapshot({ match: { id: "match-id", replay: { steps: [] } } });
    expect(compareSnapshots(valid, invalid).failed[0].issues).toEqual([
      { side: "after", path, reason },
    ]);
    expect(compareSnapshots(invalid, valid).failed[0].issues).toEqual([
      { side: "before", path, reason },
    ]);
  },
);

test("snapshotは不正応答も保存し、不正な局のidと理由を報告できる", async () => {
  const { report } = planSnapshotMatches(
    snapshotConversionFixtures.slice(0, 5).map(({ json }) => exportRow(json)),
  );
  const bodies = [
    JSON.stringify({ error: "unavailable" }),
    "<html>unavailable</html>",
    JSON.stringify({ match: { id: "other-id", replay: { steps: [] } } }),
    JSON.stringify({ match: { id: report.converted[3].id, replay: {} } }),
    JSON.stringify({ match: { id: report.converted[4].id, replay: { steps: [] } } }),
  ];
  let index = 0;
  const saved: ApiSnapshot[] = [];
  const request = vi.fn<typeof fetch>(async () => {
    const current = index++;
    return new Response(bodies[current], { status: current === 0 ? 503 : 200 });
  });
  const result = await snapshotMatches(report, "https://example.invalid", {
    fetch: request,
    sleep: async () => {},
    save: async (value) => {
      saved.push(structuredClone(value));
    },
  });
  expect(saved.at(-1)).toEqual(result);
  expect(result.matches.map(({ body }) => body)).toEqual(bodies);
  expect(result.matches[0].status).toBe(503);
  const invalid = invalidSnapshotResponses(result);
  expect(invalid).toHaveLength(4);
  expect(invalid.map(({ id }) => id)).toEqual(report.converted.slice(0, 4).map(({ id }) => id));
  expect(invalid[0].issues).toContainEqual({
    path: "$status",
    reason: "Expected HTTP 200, received 503",
  });
  expect(invalid[1].issues).toEqual([
    { path: "$body.invalid-json", reason: "Response body is not valid JSON" },
  ]);
  expect(invalid[2].issues[0].path).toBe('$["match"]["id"]');
  expect(invalid[3].issues[0].path).toBe('$["match"]["replay"]["steps"]');
});
