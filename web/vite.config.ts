import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiProxy = () => ({
  target: "http://127.0.0.1:3000",
  changeOrigin: false,
});

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": apiProxy(),
      "/admin": apiProxy(),
      "/mcp": apiProxy(),
      "/healthz": apiProxy(),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("gsap")) return "motion";
          if (id.includes("@phosphor-icons")) return "icons";
          if (id.includes("@tanstack")) return "query";
          if (id.includes("react")) return "react";
          return "vendor";
        },
      },
    },
  },
});
