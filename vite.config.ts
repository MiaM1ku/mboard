import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", target: "es2022", sourcemap: false },
  server: {
    port: 5180,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8787", "/s/": "http://127.0.0.1:8787" },
  },
});
