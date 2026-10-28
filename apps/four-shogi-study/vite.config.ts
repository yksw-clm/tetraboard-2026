import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5197,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5198",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (request, incoming) => {
            if (incoming.headers.origin === "http://127.0.0.1:5197")
              request.setHeader("Origin", "http://127.0.0.1:5198");
          });
        },
      },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
