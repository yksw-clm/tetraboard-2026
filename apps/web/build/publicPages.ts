import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { gameIds } from "@tetraboard/protocol/games";
import { findPublicPage } from "../src/publicPages/catalog.ts";
const prefix = "virtual:public-rules/";
export function publicPagesPlugin(): Plugin {
  return {
    name: "public-rules",
    resolveId(id) {
      if (gameIds.some((game) => id === `${prefix}${game}`)) return `\0${id}`;
    },
    load(id) {
      if (!id.startsWith(`\0${prefix}`)) return;
      const content = execFileSync(
        "bun",
        [
          fileURLToPath(new URL("./readPublicRules.ts", import.meta.url)),
          id.slice(prefix.length + 1),
        ],
        { encoding: "utf8" },
      );
      return `export default ${content};`;
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, _response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const page = findPublicPage(url.pathname);
        if (page) request.url = `${page.path}/index.html${url.search}`;
        next();
      });
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const page = findPublicPage(new URL(request.url ?? "/", "http://localhost").pathname);
        if (!page || (request.method !== "GET" && request.method !== "HEAD")) return next();
        try {
          const html = execFileSync(
            "bun",
            [
              fileURLToPath(new URL("./renderPublicPage.tsx", import.meta.url)),
              page.game,
              page.kind,
            ],
            { encoding: "utf8" },
          );
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(
            request.method === "HEAD"
              ? undefined
              : await server.transformIndexHtml(page.path, html),
          );
        } catch (error) {
          next(error);
        }
      });
      const files = [
        "../../../README.md",
        "../../../docs/rules/four-shogi.md",
        "../../../docs/rules/four-reversi.md",
      ].map((file) => fileURLToPath(new URL(file, import.meta.url)));
      server.watcher.add(files);
      server.watcher.on("change", (file) => {
        if (files.includes(file)) {
          for (const game of gameIds) {
            const module = server.environments.client.moduleGraph.getModuleById(
              `\0${prefix}${game}`,
            );
            if (module) server.environments.client.moduleGraph.invalidateModule(module);
          }
          server.ws.send({ type: "full-reload" });
        }
      });
    },
  };
}
