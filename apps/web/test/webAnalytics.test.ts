import { expect, test } from "bun:test";

test.each([
  { command: "build", origin: undefined, enabled: true },
  { command: "build", origin: "https://tetraboard.net", enabled: true },
  {
    command: "build",
    origin: "https://tetraboard-dev.chaossi-lab.workers.dev",
    enabled: false,
  },
  { command: "build", origin: "http://localhost:5173", enabled: false },
  { command: "build", origin: "https://example.com", enabled: false },
  { command: "serve", origin: undefined, enabled: false },
  { command: "serve", origin: "https://tetraboard.net", enabled: false },
])("Web Analytics: $command / $origin は挿入=$enabled", ({ command, origin, enabled }) => {
  const env = { ...process.env };
  delete env.VITE_PUBLIC_ORIGIN;
  delete env.VITE_SEARCH_INDEXABLE;
  if (origin !== undefined) env.VITE_PUBLIC_ORIGIN = origin;
  env.WEB_ANALYTICS_TEST_COMMAND = command;
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
        import { build, createServer } from "vite";
        import { mkdtemp, writeFile, rm } from "node:fs/promises";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        import { webAnalytics } from "./build/webAnalytics";
        const root = await mkdtemp(join(tmpdir(), "tb42-web-analytics-"));
        const template = '<!doctype html><html><head><title>TetraBoard</title></head><body><div id="root"></div></body></html>';
        try {
          await writeFile(join(root, "index.html"), template);
          const config = { root, configFile: false, envFile: false, publicDir: false, logLevel: "silent", plugins: [webAnalytics()] };
          if (process.env.WEB_ANALYTICS_TEST_COMMAND === "build") {
            const result = await build({ ...config, build: { write: false } });
            const html = result.output.find(asset => asset.fileName === "index.html");
            console.log(JSON.stringify(html.source));
          } else {
            const server = await createServer({ ...config, server: { middlewareMode: true, hmr: false, watch: null } });
            try {
              console.log(JSON.stringify(await server.transformIndexHtml("/", template)));
            } finally {
              await server.close();
            }
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      `,
    ],
    { cwd: new URL("..", import.meta.url).pathname, env },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const html: string = JSON.parse(result.stdout.toString());
  if (enabled) {
    expect(html.match(/https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js/g)).toHaveLength(
      1,
    );
    expect(html).toMatch(
      /<!-- Cloudflare Web Analytics --><script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js" data-cf-beacon='\{"token": "[0-9a-f]{32}"\}'><\/script><!-- End Cloudflare Web Analytics --><\/head>/,
    );
  } else {
    expect(html).not.toContain("cloudflareinsights.com");
    expect(html).not.toContain("data-cf-beacon");
  }
});
