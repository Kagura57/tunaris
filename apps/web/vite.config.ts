import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  preview: {
    allowedHosts: ["kwizik.app", "api.kwizik.app"],
  },
  server: {
    allowedHosts: ["kwizik.app", "api.kwizik.app"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) {
            return "vendor";
          }
          if (
            id.includes("node_modules/@tanstack/react-query") ||
            id.includes("node_modules/@tanstack/react-router")
          ) {
            return "tanstack";
          }
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
