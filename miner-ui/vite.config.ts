import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ["buffer", "process", "crypto", "stream", "util"],
      globals: { Buffer: true, process: true, global: true },
    }),
  ],
  define: {
    "process.env": {},
  },
  worker: {
    format: "es",
    plugins: () => [
      nodePolyfills({
        include: ["buffer", "process"],
        globals: { Buffer: true, process: true, global: true },
      }),
    ],
  },
});
