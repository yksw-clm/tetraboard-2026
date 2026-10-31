export interface Workspace {
  path: string;
  name: string;
  dependencies: string[];
  uncertainty?: string;
}

export interface Plan {
  mode: "fast" | "full";
  workspaces: string[];
  reasons: string[];
}

export function fullReason(
  eventName: string | undefined,
  base?: string,
  labels: string[] = [],
): string | undefined {
  if (eventName !== "pull_request") return "PR以外はFull CIを必須にします";
  if (base === "main") return "本番リリースPRはFull CIを必須にします";
  if (base !== "develop") return "対象ブランチを確定できないためFull CIを必須にします";
  if (labels.includes("ci-full")) return "ci-fullラベルによる全体検証です";
}

// API・永続化・ルールはPRでも全体検証します。未知のworkspaceも同じ扱いです。
const fastWorkspaces = new Set([
  "apps/web",
  "apps/admin",
  "apps/four-shogi-study",
  "packages/shogi-ui",
]);

export function selectPlan(files: string[], workspaces: Workspace[], forceFull?: string): Plan {
  const all = workspaces.map((workspace) => workspace.path).sort();
  const full = (reason: string): Plan => ({ mode: "full", workspaces: all, reasons: [reason] });
  if (forceFull) return full(forceFull);
  const uncertain = workspaces.find((workspace) => workspace.uncertainty);
  if (uncertain) return full(`依存解決が不確実: ${uncertain.uncertainty}`);
  if (files.length === 0) return full("差分が空か取得できないため全体を確認します");
  const affected = new Set<string>();
  for (const file of files) {
    // ルール正本・実行可能な資料・設定文書は省略対象にしません。
    if (file === "README.md" || (/^docs\/.*\.md$/.test(file) && !file.startsWith("docs/rules/")))
      continue;
    const workspace = workspaces.find((entry) => file.startsWith(`${entry.path}/`));
    if (!workspace || !fastWorkspaces.has(workspace.path))
      return full(`広範囲または未分類: ${file}`);
    const relative = file.slice(workspace.path.length + 1);
    if (!/^(src|test|test-dom|assets|public)\//.test(relative))
      return full(`ビルド・設定または未分類: ${file}`);
    if (!/\.(tsx?|css|json|svg|png|webp|jpg|woff2?)$/.test(relative))
      return full(`未分類のファイル形式: ${file}`);
    affected.add(workspace.path);
  }
  // 宣言依存だけでなく、相対importで共有するfixture・DOM支援も逆方向へたどります。
  let added = true;
  while (added) {
    added = false;
    for (const workspace of workspaces) {
      if (affected.has(workspace.path)) continue;
      if (workspace.dependencies.some((dependency) => affected.has(dependency))) {
        affected.add(workspace.path);
        added = true;
      }
    }
  }
  if ([...affected].some((path) => !fastWorkspaces.has(path)))
    return full("依存先にAPI・ルールまたは未知のworkspaceが含まれます");
  return {
    mode: "fast",
    workspaces: [...affected].sort(),
    reasons: [
      affected.size
        ? "変更workspaceと推移的な利用側を検証します"
        : "文書の整形と共通の静的検証を確認します",
    ],
  };
}
