import { publicPagesPlugin } from "./build/publicPages.ts";
import { gameChunks } from "./build/gameChunks.ts";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";

const revision =
  process.env.VITE_APP_REVISION ??
  execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();

// https://vite.dev/config/
export default defineConfig({
  define: { "import.meta.env.VITE_APP_REVISION": JSON.stringify(revision) },
  plugins: [
    publicPagesPlugin(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    gameChunks(),
  ],
  optimizeDeps: { exclude: ["@jsquash/webp"] },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/admin": { target: "http://127.0.0.1:5174", ws: true },
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
