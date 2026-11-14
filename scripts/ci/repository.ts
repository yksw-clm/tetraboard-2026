import { readdirSync } from "node:fs";
import { resolve } from "node:path";

export const root = resolve(import.meta.dir, "../..");

export function readWorkspaces(): string[] {
  return ["apps", "packages"]
    .flatMap((group) =>
      readdirSync(resolve(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${group}/${entry.name}`),
    )
    .sort();
}
