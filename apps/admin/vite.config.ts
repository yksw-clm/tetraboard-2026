import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:8787" } },
});
