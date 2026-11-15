import { readdirSync } from "node:fs";
import { resolve } from "node:path";

export const root = resolve(import.meta.dir, "../..");

export function readWorkspaces(repositoryRoot = root): string[] {
  return ["apps", "packages"]
    .flatMap((group) =>
      readdirSync(resolve(repositoryRoot, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          const path = `${group}/${entry.name}`;
          if (path !== "packages/contexts") return [path];
          return readdirSync(resolve(repositoryRoot, path), { withFileTypes: true })
            .filter((context) => context.isDirectory())
            .map((context) => `${path}/${context.name}`);
        }),
    )
    .sort();
}
