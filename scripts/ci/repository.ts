import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import type { Workspace } from "./impact";

export const root = resolve(import.meta.dir, "../..");

export function git(args: string[], cwd = root): string {
  // commit hookのGIT_DIR・GIT_INDEX_FILE等を別checkoutや一時repoへ持ち込みません。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

export function changedFiles(base: string, head = "HEAD", cwd = root): string[] {
  // PRのbase tipとcheckoutしたmerge commitを比較し、base更新・削除・rename元も含めます。
  // merge-base比較では、base側だけに入った変更の影響を見落とす可能性があります。
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("base SHAがありません");
  return git(["diff", "--name-only", "--no-renames", "-z", base, head, "--"], cwd)
    .split("\0")
    .filter(Boolean);
}

export function readWorkspaces(): Workspace[] {
  const manifests = ["apps", "packages"].flatMap((group) =>
    readdirSync(resolve(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = `${group}/${entry.name}`;
        const manifest = JSON.parse(readFileSync(resolve(root, path, "package.json"), "utf8"));
        return { path, manifest };
      }),
  );
  const workspaces: Workspace[] = manifests.map(({ path, manifest }) => ({
    path,
    name: manifest.name,
    dependencies: manifests
      .filter((dependency) =>
        [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some(
          (section) => section?.[dependency.manifest.name],
        ),
      )
      .map((dependency) => dependency.path),
  }));
  for (const file of git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split(
    "\0",
  )) {
    if (!/\.(tsx?|mts|css|json)$/.test(file)) continue;
    if (!existsSync(resolve(root, file))) continue;
    const owner = workspaces.find((workspace) => file.startsWith(`${workspace.path}/`));
    if (!owner) continue;
    // 型import・CSS・new URLの静的パスも含め、実行時importだけに限定しません。
    const source = readFileSync(resolve(root, file), "utf8");
    if (
      /^apps\/(web|admin|four-shogi-study)\//.test(file) ||
      file.startsWith("packages/shogi-ui/")
    ) {
      for (const match of source.matchAll(/(?<![.\w])import\s*\(\s*([^)]*)\)(?!\s*[:{])/g)) {
        if (!/^(?:["'][^"']+["']|`[^`$]+`)$/.test(match[1].trim()))
          owner.uncertainty = `${file}: 動的importの対象を確定できません`;
      }
      if (/\.(tsx?|mts)$/.test(file)) {
        try {
          const references = new Set([
            ...new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" })
              .scanImports(source)
              .map((imported) => imported.path),
            // scanImportsが消去する型専用import/exportのaliasも解決します。
            ...[
              ...source.matchAll(
                /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|[\w$]+)\s+from\s*["']([^"'\s]+)["']/g,
              ),
            ].map((match) => match[1]),
          ]);
          for (const reference of references) {
            // tsconfigのaliasも実際の解決先を使います。未解決の参照はFullへ倒します。
            const target = Bun.resolveSync(reference, dirname(resolve(root, file)));
            const dependency = workspaces.find((workspace) =>
              target.startsWith(`${root}/${workspace.path}/`),
            );
            if (dependency && dependency !== owner && !owner.dependencies.includes(dependency.path))
              owner.dependencies.push(dependency.path);
          }
        } catch (error) {
          owner.uncertainty = `${file}: ${String(error)}`;
        }
      }
    }
    for (const match of source.matchAll(/["'`]((?:\.{1,2}\/|@tetraboard\/)[^"'`\s]+)["'`]/g)) {
      const reference = match[1];
      const target = reference.startsWith(".")
        ? posix.normalize(`${dirname(file)}/${reference}`)
        : null;
      const dependency = workspaces.find((workspace) =>
        target
          ? target === workspace.path || target.startsWith(`${workspace.path}/`)
          : reference === workspace.name || reference.startsWith(`${workspace.name}/`),
      );
      if (dependency && dependency !== owner && !owner.dependencies.includes(dependency.path))
        owner.dependencies.push(dependency.path);
    }
  }
  return workspaces.sort((a, b) => a.path.localeCompare(b.path));
}
