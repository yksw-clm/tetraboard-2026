import { mkdir, writeFile } from "node:fs/promises";
import type { Plugin } from "vite";

/** ビルドされた静的依存を検査し、ゲーム画面の遅延読み込みを維持する。 */
function hasImplementation(code: string | null | undefined): boolean {
  // Rolldownはtree-shake済みモジュールにもregionとReact Compilerの共通runtime初期化を記録する。
  return Boolean(
    code
      ?.replace(/\/\/#(?:end)?region[^\n]*\n?/g, "")
      .replace(/var import_compiler_runtime = require_compiler_runtime\(\);/g, "")
      .trim(),
  );
}
export function gameChunks(): Plugin {
  return {
    name: "game-chunk-boundaries",
    async generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
      const dependencies = (file: string, seen = new Set<string>()): Set<string> => {
        if (seen.has(file)) return seen;
        seen.add(file);
        const chunk = chunks.find((entry) => entry.fileName === file);
        for (const dependency of chunk?.imports ?? []) dependencies(dependency, seen);
        return seen;
      };
      const modulesFor = (file: string) =>
        [...dependencies(file)].flatMap((dependency) => {
          const chunk = chunks.find((entry) => entry.fileName === dependency);
          return Object.entries(chunk?.modules ?? {})
            .filter(([, info]) => hasImplementation(info.code))
            .map(([id]) => id);
        });
      for (const chunk of chunks) {
        for (const [id, info] of Object.entries(chunk.modules)) {
          if (
            /\/packages\/(four-reversi|four-shogi|reversi|shogi)\/src\/cpu[^/]*\.ts$/.test(id) &&
            hasImplementation(info.code)
          ) {
            this.error(`CPU implementation emitted in ${chunk.fileName}: ${id}`);
          }
        }
      }
      const entries = [
        "ReversiRoomDetail",
        "ReversiMatchReplayView",
        "FourReversiRoomDetail",
        "FourShogiRoomDetail",
        "FourReversiMatchReplayView",
        "FourShogiMatchReplayView",
        "fourShogiMatchReplay",
        "ShogiRoomDetail",
        "ShogiMatchReplayView",
        "standardShogiMatchReplay",
      ];
      const main = chunks.find((chunk) => chunk.isEntry);
      if (!main) this.error("Missing Web entry chunk");
      const initialModules = modulesFor(main.fileName);
      for (const entry of entries) {
        const suffix = `/features/room/${entry}.${entry.endsWith("MatchReplay") ? "ts" : "tsx"}`;
        const chunk = chunks.find((output) =>
          Object.keys(output.modules).some((id) => id.endsWith(suffix)),
        );
        if (!chunk?.isDynamicEntry || initialModules.some((id) => id.endsWith(suffix)))
          this.error(`${entry} must be a lazy entry`);
        const own = entry.startsWith("Reversi")
          ? "reversi"
          : entry.includes("Reversi")
            ? "four-reversi"
            : entry.startsWith("Four") || entry.startsWith("four")
              ? "four-shogi"
              : "shogi";
        for (const other of ["reversi", "four-reversi", "four-shogi", "shogi"]) {
          if (
            other !== own &&
            modulesFor(chunk.fileName).some((id) => id.includes(`/packages/${other}/src/`))
          )
            this.error(`${entry} statically loads ${other}`);
        }
      }
      const report = chunks.map((chunk) => ({
        file: chunk.fileName,
        entry: chunk.isEntry,
        dynamicEntry: chunk.isDynamicEntry,
        imports: chunk.imports,
        dynamicImports: chunk.dynamicImports,
        modules: Object.entries(chunk.modules)
          .filter(([, info]) => hasImplementation(info.code))
          .map(([id]) => id),
      }));
      await mkdir("node_modules/.tmp", { recursive: true });
      await writeFile("node_modules/.tmp/game-chunks.json", JSON.stringify(report, null, 2));
      console.info(
        "Game chunk boundaries: lazy live/replay entries, no cross-game engines, no CPU implementation",
      );
    },
  };
}
