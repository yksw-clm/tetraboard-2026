import { expect, test } from "bun:test";
import { fullReason, selectPlan, type Workspace } from "../impact";
import { readWorkspaces } from "../repository";

// 選択方針の単体テストは、実repoの動的import追加から独立した既知の依存で検証します。
const workspaces: Workspace[] = [
  { path: "apps/admin", name: "admin", dependencies: ["apps/web"] },
  {
    path: "apps/four-shogi-study",
    name: "study",
    dependencies: ["apps/web", "packages/shogi-ui", "packages/four-shogi", "packages/protocol"],
  },
  {
    path: "apps/web",
    name: "web",
    dependencies: ["packages/shogi-ui", "packages/four-shogi", "packages/protocol"],
  },
  { path: "packages/shogi-ui", name: "shogi-ui", dependencies: [] },
  { path: "packages/four-shogi", name: "four-shogi", dependencies: [] },
  { path: "packages/protocol", name: "protocol", dependencies: [] },
];

test("実repoの依存が不確実な場合は文書変更でもFull検証を省略しない", () => {
  const actual = readWorkspaces();
  expect(actual.length).toBeGreaterThan(0);
  const uncertain = actual.find((workspace) => workspace.uncertainty);
  const plan = selectPlan(["README.md", "docs/testing.md"], actual);
  if (uncertain) {
    expect(plan.mode).toBe("full");
    expect(plan.workspaces).toEqual(actual.map((workspace) => workspace.path).sort());
    expect(plan.reasons).toEqual([`依存解決が不確実: ${uncertain.uncertainty}`]);
  } else {
    expect(plan).toMatchObject({ mode: "fast", workspaces: [] });
  }
});
test("push・main向けPR・明示Full・不明イベントはFast成功をデプロイ条件に使わない", () => {
  expect(fullReason("pull_request", "develop")).toBeUndefined();
  for (const reason of [
    fullReason("push", "develop"),
    fullReason("pull_request", "main"),
    fullReason("pull_request", "develop", ["ci-full"]),
    fullReason(undefined),
    fullReason("pull_request"),
  ])
    expect(reason).toBeString();
});
test.each([
  ["apps/admin/src/App.tsx", ["apps/admin"]],
  ["apps/four-shogi-study/src/search/runtime.ts", ["apps/four-shogi-study"]],
  ["apps/web/src/app/router.tsx", ["apps/admin", "apps/four-shogi-study", "apps/web"]],
  [
    "packages/shogi-ui/src/ShogiPiece.tsx",
    ["apps/admin", "apps/four-shogi-study", "apps/web", "packages/shogi-ui"],
  ],
] as const)("%s は利用側まで検証する", (file, expected) => {
  const plan = selectPlan([file, "docs/testing.md"], workspaces);
  expect(plan.mode).toBe("fast");
  expect(plan.workspaces).toEqual([...expected]);
});

test.each([
  "packages/protocol/src/index.ts",
  "packages/four-shogi/src/movement.ts",
  "apps/worker/src/accounts/auth.ts",
  "apps/worker/migrations/001.sql",
  "apps/four-shogi-ai/src/http.ts",
  "apps/web/vite.config.ts",
  "apps/web/package.json",
  "bun.lock",
  ".github/workflows/ci.yml",
  "test-support/dom.ts",
  "test-fixtures/matches/shogi-singles.json",
  "docs/rules/four-shogi.md",
  "unknown/file.ts",
  "apps/admin/src/unknown.wasm",
])("%s はFullへフォールバックする", (file) => {
  const plan = selectPlan([file], workspaces);
  expect(plan.mode).toBe("full");
  expect(plan.workspaces).toHaveLength(workspaces.length);
});

test("文書だけ・空差分・明示Fullを区別する", () => {
  expect(selectPlan(["README.md", "docs/testing.md"], workspaces)).toMatchObject({
    mode: "fast",
    workspaces: [],
  });
  expect(selectPlan([], workspaces).mode).toBe("full");
  expect(
    selectPlan(["apps/admin/src/App.tsx"], [{ ...workspaces[0], uncertainty: "unknown alias" }])
      .mode,
  ).toBe("full");
  expect(selectPlan(["apps/admin/src/App.tsx"], workspaces, "release").mode).toBe("full");
});

test("新しい依存辺・循環・未知の利用側があっても必要な検証を省略しない", () => {
  const graph: Workspace[] = [
    { path: "apps/admin", name: "admin", dependencies: ["apps/web"] },
    { path: "apps/web", name: "web", dependencies: ["apps/admin"] },
    { path: "apps/new-consumer", name: "new", dependencies: ["apps/web"] },
  ];
  expect(selectPlan(["apps/admin/src/App.tsx"], graph)).toMatchObject({
    mode: "full",
    workspaces: ["apps/admin", "apps/new-consumer", "apps/web"],
  });
});
