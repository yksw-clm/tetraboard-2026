import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "vite";

const webDirectory = fileURLToPath(new URL("../", import.meta.url));

export function publicImageAssetFromManifest(manifest: Manifest, source: string): string {
  const key = relative(webDirectory, source);
  const asset = manifest[key]?.file;
  if (!asset || !/^assets\/[^/]+-[\w-]{8}\.(?:webp|png)$/.test(asset)) {
    throw new Error(`Missing built public image asset: ${key}`);
  }
  return `/${asset}`;
}
