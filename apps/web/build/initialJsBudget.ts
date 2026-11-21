import { brotliCompressSync, constants } from "node:zlib";
import type { Plugin } from "vite";

const budgets = {
  GeneralLobbyPage: 305,
  FourReversiLobbyPage: 335,
  FourShogiLobbyPage: 335,
  FourShogiRulesPage: 245,
  ReversiLobbyPage: 335,
  ShogiLobbyPage: 335,
  GomokuLobbyPage: 335,
  FourGomokuLobbyPage: 335,
  RoomPage: 240,
  MatchReplayPage: 240,
};
const bytesPerKiB = 1024;

export function initialJsBudget(): Plugin {
  return {
    name: "initial-js-budget",
    generateBundle: {
      // Viteが動的importのプリロード情報を書き込んだ後に計測します。
      order: "post",
      handler(_options, bundle) {
        const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
        const chunksByFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
        const entries = chunks.filter((chunk) => chunk.isEntry);
        if (!entries.length) this.error("Missing Web entry chunk");

        function addStaticImports(chunk: (typeof chunks)[number], files: Set<string>) {
          if (files.has(chunk.fileName)) return;
          files.add(chunk.fileName);
          for (const file of chunk.imports) {
            const dependency = chunksByFile.get(file);
            if (dependency) addStaticImports(dependency, files);
          }
        }

        const entryFiles = new Set<string>();
        for (const entry of entries) addStaticImports(entry, entryFiles);

        const sizes = new Map<string, number>();
        const violations: string[] = [];
        for (const [page, budget] of Object.entries(budgets)) {
          const route = chunks.find((chunk) =>
            Object.keys(chunk.modules).some((id) => id.endsWith(`/${page}.tsx`)),
          );
          if (!route) this.error(`Missing route chunk for ${page}`);
          const files = new Set(entryFiles);
          addStaticImports(route, files);

          let bytes = 0;
          for (const file of files) {
            let size = sizes.get(file);
            if (size === undefined) {
              size = brotliCompressSync(chunksByFile.get(file)!.code, {
                params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
              }).byteLength;
              sizes.set(file, size);
            }
            bytes += size;
          }

          const report = `${page}: ${(bytes / bytesPerKiB).toFixed(2)} KiB / ${budget} KiB`;
          console.info(`Initial JS (Brotli): ${report}`);
          if (bytes > budget * bytesPerKiB) violations.push(report);
        }
        if (violations.length) this.error(`Initial JS budget exceeded:\n${violations.join("\n")}`);
      },
    },
  };
}
