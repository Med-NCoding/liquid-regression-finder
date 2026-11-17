import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiOrigin = process.env.VITE_API_ORIGIN || "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: apiOrigin,
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      "/api": {
        target: apiOrigin,
        changeOrigin: true,
      },
    },
  },
});
