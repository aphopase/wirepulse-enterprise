import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // The original source never ships next to the bundle.
    sourcemap: false,
    // Third-party code in its own file, so scripts/protect-frontend.mjs can transform only WirePulse's own code.
    rollupOptions: { output: { manualChunks: (id) => (id.includes("node_modules") ? "vendor" : undefined) } }
  }
});
