import { expect, test } from "bun:test";
import { fullReason, selectPlan, type Workspace } from "../impact";
import { readWorkspaces } from "../repository";

const workspaces = readWorkspaces();
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
