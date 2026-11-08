import { mkdir, copyFile } from "node:fs/promises";
await mkdir(new URL("./dist", import.meta.url), { recursive: true });
for (const entry of ["bridge", "content", "background", "options"]) {
  const result = await Bun.build({
    entrypoints: [new URL(`./src/${entry}.ts`, import.meta.url).pathname],
    outdir: new URL("./dist", import.meta.url).pathname,
    target: "browser",
    format: ["background", "options"].includes(entry) ? "esm" : "iife",
    minify: false,
  });
  if (!result.success)
    throw new AggregateError(result.logs, `拡張の${entry}をビルドできませんでした`);
}
for (const file of ["manifest.json", "options.html"])
  await copyFile(new URL(file, import.meta.url), new URL(`dist/${file}`, import.meta.url));
