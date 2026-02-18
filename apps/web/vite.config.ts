import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
          tanstack: ["@tanstack/react-query", "@tanstack/react-router"],
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
