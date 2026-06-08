import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { visualizer } from "rollup-plugin-visualizer";

function manualChunks(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  if (id.includes("node_modules/react") || id.includes("node_modules/react-dom") || id.includes("node_modules/scheduler")) {
    return "react-vendor";
  }
  if (id.includes("node_modules/@radix-ui")) return "radix-vendor";
  if (id.includes("node_modules/lucide-react")) return "icons-vendor";
  if (id.includes("node_modules/@tauri-apps")) return "tauri-vendor";
  if (id.includes("node_modules/sonner") || id.includes("node_modules/class-variance-authority") || id.includes("node_modules/clsx") || id.includes("node_modules/tailwind-merge")) {
    return "ui-vendor";
  }
  return "vendor";
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...(process.env.CBPANEL_ANALYZE
      ? [
          visualizer({
            brotliSize: true,
            filename: "dist/bundle-analysis.html",
            gzipSize: true,
            template: "treemap",
          }),
          visualizer({
            brotliSize: true,
            filename: "dist/bundle-stats.json",
            gzipSize: true,
            template: "raw-data",
          }),
        ]
      : []),
  ],
  build: {
    rolldownOptions: {
      output: {
        manualChunks,
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
