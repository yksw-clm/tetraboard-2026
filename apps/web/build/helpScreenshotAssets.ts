import { access } from "node:fs/promises";
import type { Manifest } from "vite";
import { helpScreenshots } from "../src/features/help/helpScreenshots";
import { publicImageAssetFromManifest } from "./publicImageAssets";

export async function helpScreenshotsFromManifest(
  manifest: Manifest,
  dist: URL,
): Promise<typeof helpScreenshots> {
  const screenshots = { ...helpScreenshots };
  for (const name of Object.keys(screenshots) as (keyof typeof screenshots)[]) {
    const screenshot = screenshots[name];
    const src = publicImageAssetFromManifest(manifest, screenshot.src);
    await access(new URL(src.slice(1), dist));
    screenshots[name] = { ...screenshot, src };
  }
  return screenshots;
}
