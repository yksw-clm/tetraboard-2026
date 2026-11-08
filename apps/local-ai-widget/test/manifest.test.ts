import { expect, test } from "bun:test";
test("配布物はMV3で、ホストと実行環境を限定し外部コードを読み込まない", async () => {
  const m = await Bun.file(new URL("../dist/manifest.json", import.meta.url)).json();
  expect(m.manifest_version).toBe(3);
  expect(m.permissions).toEqual(["storage"]);
  expect(m.host_permissions).toEqual(["http://127.0.0.1/*"]);
  expect(m.content_scripts.map((s: { world: string }) => s.world)).toEqual(["MAIN", "ISOLATED"]);
  for (const s of m.content_scripts) {
    expect(s.run_at).toBe("document_start");
    expect(s.matches).toHaveLength(4);
    expect(s.matches.some((s: string) => s.includes("<all_urls>"))).toBe(false);
    for (const file of s.js)
      expect(await Bun.file(new URL(`../dist/${file}`, import.meta.url)).exists()).toBe(true);
  }
  expect(await Bun.file(new URL("../dist/options.html", import.meta.url)).text()).toContain(
    'type="module"',
  );
});
